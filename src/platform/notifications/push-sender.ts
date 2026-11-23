import { Injectable, Logger } from '@nestjs/common';

/** One push to one phone. The text is the inbox text: no marks, amounts or IDs (SDD 18). */
export interface PushMessage {
  token: string;
  /** 1 Android, 2 iOS. */
  platform: number;
  /** The language the phone asked for (`push_devices.app_language`). */
  language: string;
  title: string;
  body: string;
}

/** What became of one push: sent, or the provider says the token is no longer valid and the worker removes it. */
export type PushOutcome = 'sent' | 'invalid_token' | 'failed';

/**
 * The push provider behind one interface (SDD 18): the log driver below in development, tests and demo, and the
 * Firebase driver (`firebase-push-sender.ts`), switched on by `PUSH_DRIVER`. It answers one outcome per message, in order; one that cannot
 * reach the provider at all throws, and the worker goes on without it (the inbox row is already written).
 */
export abstract class PushSender {
  abstract send(messages: PushMessage[]): Promise<PushOutcome[]>;
}

/** Sends nothing: it says how many pushes there would have been, never to whom or what they said. */
@Injectable()
export class LogPushSender extends PushSender {
  private readonly logger = new Logger(LogPushSender.name);

  send(messages: PushMessage[]): Promise<PushOutcome[]> {
    this.logger.log({ count: messages.length }, 'Pushes not sent: the log driver is in use');
    return Promise.resolve(messages.map(() => 'sent'));
  }
}
