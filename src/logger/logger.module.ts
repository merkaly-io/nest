import { DynamicModule, Global, Module } from '@nestjs/common';
import { LOGGER_OPTIONS, LoggerModuleAsyncOptions, LoggerModuleOptions } from './logger.options';
import { LoggerService } from './logger.service';

@Global()
@Module({})
export class LoggerModule {
  static forRoot(options: LoggerModuleOptions): DynamicModule {
    return {
      module: LoggerModule,
      providers: [{ provide: LOGGER_OPTIONS, useValue: options }, LoggerService],
      exports: [LoggerService],
    };
  }

  static forRootAsync({
    imports = [],
    inject = [],
    useFactory,
  }: LoggerModuleAsyncOptions): DynamicModule {
    return {
      module: LoggerModule,
      imports,
      providers: [{ provide: LOGGER_OPTIONS, inject, useFactory }, LoggerService],
      exports: [LoggerService],
    };
  }
}
