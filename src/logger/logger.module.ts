import { DynamicModule, Global, Module } from '@nestjs/common';
import { LOGGER_OPTIONS, LoggerModuleOptions } from './logger.options';
import { LoggerService } from './logger.service';

@Global()
@Module({ providers: [LoggerService], exports: [LoggerService] })
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions = {}): DynamicModule {
    return {
      module: LoggerModule,
      providers: [{ provide: LOGGER_OPTIONS, useValue: options }, LoggerService],
      exports: [LoggerService],
    };
  }
}
