import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { config } from './config';
import { Db } from './db/db.service';
import { prepararBase } from './db/migraciones';

export async function crearApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: ['error', 'warn', 'log'] });
  const c = config();
  app.enableCors({ origin: c.origenesCors, credentials: true, exposedHeaders: ['Content-Disposition'] });
  app.useBodyParser('json', { limit: '10mb' });
  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  return app;
}

async function iniciar() {
  const app = await crearApp();
  const c = config();
  if (c.migrarAlIniciar) await prepararBase(app.get(Db));
  await app.listen(c.puerto, '0.0.0.0');
  new Logger('Jornal360').log(`API lista en el puerto ${c.puerto}`);
}

if (require.main === module) {
  iniciar().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  });
}
