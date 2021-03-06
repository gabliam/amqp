import amqp = require('amqplib');
import { Queue } from './queue';
import { interfaces } from '@gabliam/core';
import {
  ConsumerHandler,
  ConsumeOptions,
  SendOptions,
  Message,
  ConsumeConfig,
  RabbitHandlerMetadata,
  Controller
} from './interfaces';
import * as uuid from 'uuid';
import * as PromiseB from 'bluebird';
import { AmqpTimeout } from './errors';

enum ConnectionState {
  stopped,

  running,

  starting,

  stopping
}

export class AmqpConnection {
  private connection: amqp.Connection;

  private channel: amqp.Channel;

  private state = ConnectionState.stopped;

  private consumerList: ConsumeConfig[] = [];

  constructor(
    private url: string,
    private queues: Queue[],
    private valueExtractor: interfaces.ValueExtractor
  ) {}

  async start() {
    if (this.state !== ConnectionState.stopped) {
      return;
    }

    this.state = ConnectionState.starting;
    this.connection = await amqp.connect(this.url);
    const ch = (this.channel = await this.connection.createChannel());
    for (const queue of this.queues) {
      await ch.assertQueue(queue.queueName, queue.queueOptions);
    }

    for (const { queueName, handler, options } of this.consumerList) {
      await ch.consume(queueName, handler, options);
    }

    this.state = ConnectionState.running;
  }

  addConsume(
    queue: string,
    handler: ConsumerHandler,
    options?: ConsumeOptions
  ) {
    const queueName = this.getQueueName(queue);
    if (!this.queueExist(queueName)) {
      throw new Error(`queue "${queueName}" doesn't exist`);
    }
    this.consumerList.push({ queueName, handler, options });
  }

  constructAndAddConsume(
    handlerMetadata: RabbitHandlerMetadata,
    controller: Controller
  ) {
    let consumeHandler: ConsumerHandler;
    if (handlerMetadata.type === 'Listener') {
      consumeHandler = this.constructListener(handlerMetadata, controller);
    } else {
      consumeHandler = this.constructConsumer(handlerMetadata, controller);
    }

    this.addConsume(
      handlerMetadata.queue,
      consumeHandler,
      handlerMetadata.consumeOptions
    );
  }

  async sendToQueue(queue: string, content: any, options?: SendOptions) {
    const queueName = this.getQueueName(queue);
    await this.channel.sendToQueue(
      queueName,
      this.contentToBuffer(content),
      options
    );
  }

  async sendToQueueAck(
    queue: string,
    content: any,
    msg: Message,
    options?: SendOptions
  ) {
    const queueName = this.getQueueName(queue);
    await this.channel.sendToQueue(
      queueName,
      this.contentToBuffer(content),
      options
    );
    await this.channel.ack(msg);
  }

  async sendAndReceive<T = any>(
    queue: string,
    content: any,
    options: SendOptions = {},
    timeout: number = 5000
  ): Promise<T> {
    let onTimeout = false;
    let promise = new PromiseB<T>((resolve, reject) => {
      const queueName = this.getQueueName(queue);
      if (!options.correlationId) {
        options.correlationId = uuid();
      }
      const correlationId = options.correlationId;

      if (!options.replyTo) {
        options.replyTo = `amqpSendAndReceive${uuid()}`;
      }

      if (!options.expiration) {
        options.expiration = '' + timeout;
      }

      const replyTo = options.replyTo;
      const chan = this.channel;

      // create new Queue for get the response
      chan
        .assertQueue(replyTo, { exclusive: true, autoDelete: true })
        .then(() => {
          return chan.consume(replyTo, (msg: Message) => {
            if (!onTimeout && msg.properties.correlationId === correlationId) {
              resolve(this.parseContent(msg));
            }
            chan.ack(msg);
          });
        })
        .then(() => {
          chan.sendToQueue(queueName, this.contentToBuffer(content), options);
        })
        // catch when error amqp (untestable)
        .catch(
          // prettier-ignore
          /* istanbul ignore next */
          (err) => {
            reject(err)
          }
        );
    });

    if (timeout) {
      promise = promise.timeout(timeout).catch(PromiseB.TimeoutError, e => {
        onTimeout = true;
        throw new AmqpTimeout(e.message);
      });
    }

    return promise;
  }

  async stop() {
    if (this.state !== ConnectionState.running) {
      return;
    }
    this.state = ConnectionState.stopping;

    await this.channel.close();
    await this.connection.close();

    this.state = ConnectionState.stopped;
  }

  queueExist(queueName: string) {
    for (const queue of this.queues) {
      if (queue.queueName === queueName) {
        return true;
      }
    }
    return false;
  }

  getQueueName(queueName: string) {
    return this.valueExtractor(
      `application.amqp.queues.${queueName}.queueName`,
      this.valueExtractor(queueName, queueName)
    );
  }

  contentToBuffer(content: any) {
    if (content instanceof Buffer) {
      return content;
    }

    if (typeof content === 'string') {
      return new Buffer(content);
    }

    return new Buffer(JSON.stringify(content));
  }

  parseContent(msg: Message) {
    try {
      return JSON.parse(msg.content.toString());
    } catch (e) {
      return msg.content.toString();
    }
  }

  private constructListener(
    handlerMetadata: RabbitHandlerMetadata,
    controller: Controller
  ): ConsumerHandler {
    return async (msg: Message) => {
      const content = this.parseContent(msg);
      await Promise.resolve(controller[handlerMetadata.key](content));
      await this.channel.ack(msg);
    };
  }

  private constructConsumer(
    handlerMetadata: RabbitHandlerMetadata,
    controller: Controller
  ): ConsumerHandler {
    return async (msg: Message) => {
      // catch when error amqp (untestable)
      /* istanbul ignore next */
      if (msg.properties.replyTo === undefined) {
        throw new Error(`replyTo is missing`);
      }

      const content = this.parseContent(msg);

      let response: any;
      let sendOptions: SendOptions;
      try {
        response = await Promise.resolve(
          controller[handlerMetadata.key](content)
        );
        sendOptions = handlerMetadata.sendOptions || {};
      } catch (err) {
        response = err;
        sendOptions = handlerMetadata.sendOptionsError || {};
      }

      this.sendToQueueAck(msg.properties.replyTo, response, msg, {
        correlationId: msg.properties.correlationId,
        contentType: 'application/json',
        ...sendOptions
      });
    };
  }
}
