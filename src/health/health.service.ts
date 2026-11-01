import { Injectable, Optional } from '@nestjs/common';
import { BrokerStatus, EventsPublisher } from '../rabbit';

export interface HealthStatus {
  status: 'ok' | 'degraded';
  broker?: BrokerStatus; // only with RabbitModule
  uptime: number; // seconds
}

@Injectable()
export class HealthService {
  constructor(@Optional() private readonly events?: EventsPublisher) {}

  check(): HealthStatus {
    const uptime = Math.round(process.uptime());

    if (!this.events) return { status: 'ok', uptime };

    const broker = this.events.status;

    return { status: broker === 'connected' ? 'ok' : 'degraded', broker, uptime };
  }
}
