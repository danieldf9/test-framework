import type { ServerResponse } from 'node:http';
import type { FastifyReply } from 'fastify';

/** Typed push events for the Studio SPA (D42). One SSE stream carries them all;
 * the web client reacts by invalidating the matching TanStack Query caches, so
 * the DB stays the single source of truth and events are only "wake up" pokes. */
export type StudioEventType =
  | 'run-started'
  | 'run-output'
  | 'run-finished'
  | 'recorder-changed'
  | 'escalation-answered'
  | 'promote-applied';

const HEARTBEAT_MS = 25_000;

/**
 * Minimal Server-Sent Events hub — raw response streams, no plugin. SSE over
 * WebSockets because Studio pushes one way only, EventSource reconnects for
 * free, and it adds zero dependencies.
 */
export class StudioEvents {
  private readonly clients = new Set<ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  /** Attach a subscriber. Hijacks the reply — Fastify must not touch it after this. */
  subscribe(reply: FastifyReply): void {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    if (!this.heartbeat) {
      // Keeps proxies/sockets from idling out; unref so it never holds the process open.
      this.heartbeat = setInterval(() => this.broadcast(': ping\n\n'), HEARTBEAT_MS);
      this.heartbeat.unref();
    }
    const drop = (): void => {
      this.clients.delete(res);
      if (this.clients.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
    };
    res.on('close', drop);
    res.on('error', drop);
  }

  emit(type: StudioEventType, payload: unknown = {}): void {
    if (this.clients.size === 0) return;
    this.broadcast(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private broadcast(frame: string): void {
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res); // torn-down socket — close handler races behind us
      }
    }
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        // already gone
      }
    }
    this.clients.clear();
  }
}
