import { DynamicModule, Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { RequestMethod } from '@nestjs/common';
import { LOGGER_OPTIONS, LoggerModuleAsyncOptions, LoggerModuleOptions } from './logger.options';
import { LoggerService } from './logger.service';
import { RequestContextMiddleware } from './request-context';

@Global()
@Module({})
export class LoggerModule implements NestModule {
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

  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(RequestContextMiddleware)
      .forRoutes({ path: '*path', method: RequestMethod.ALL });
  }
}
