import { Controller, Get, Optional } from '@nestjs/common';
import { EventsPublisher } from '../rabbit';

@Controller('health')
export class HealthController {
  constructor(@Optional() private readonly events?: EventsPublisher) {}

  @Get()
  check() {
    const uptime = Math.round(process.uptime());

    if (!this.events) return { status: 'ok', uptime }; // no RabbitModule, no broker check

    const broker = this.events.status;

    return { status: broker === 'connected' ? 'ok' : 'degraded', broker, uptime };
  }
}
