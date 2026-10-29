import { INestApplication } from '@nestjs/common';
import { Client } from 'pg';
import request from 'supertest';

/**
 * Levanta la API contra una base PostgreSQL real y nueva para cada archivo de pruebas.
 * Variable PG_TEST_URL: servidor de pruebas (por defecto localhost:5433).
 */
const SERVIDOR = process.env.PG_TEST_URL ?? 'postgres://postgres@localhost:5433';

export interface Contexto {
  app: INestApplication;
  http: () => ReturnType<typeof request>;
  token: string;
  api: (metodo: 'get' | 'post' | 'patch' | 'put' | 'delete', ruta: string, cuerpo?: unknown) => Promise<request.Response>;
  cerrar: () => Promise<void>;
  base: string;
}

export async function levantar(nombre: string): Promise<Contexto> {
  const base = `jornal_e2e_${nombre}_${process.pid}`;
  const admin = new Client({ connectionString: `${SERVIDOR}/postgres` });
  await admin.connect();
  await admin.query(`drop database if exists ${base}`);
  await admin.query(`create database ${base}`);
  await admin.end();

  process.env.DATABASE_URL = `${SERVIDOR}/${base}`;
  process.env.DATABASE_SSL = 'false';
  process.env.SUPERADMIN_USUARIO = 'Santiago';
  process.env.SUPERADMIN_PASSWORD = '123456santiago';
  process.env.PLATAFORMA_USUARIO = 'Santiago';
  process.env.PLATAFORMA_PASSWORD = 'clave-plataforma-prueba';
  process.env.JWT_SECRETO = 'prueba-jwt';
  process.env.QR_SECRETO = 'prueba-qr';
  jest.resetModules();
  const { reiniciarConfig } = await import('../../src/config');
  reiniciarConfig();
  const { crearApp } = await import('../../src/main');
  const { prepararBase } = await import('../../src/db/migraciones');
  const { Db } = await import('../../src/db/db.service');
  const app = await crearApp();
  await app.init();
  await prepararBase(app.get(Db));
  const http = () => request(app.getHttpServer());
  const login = await http().post('/api/auth/login').send({ usuario: 'Santiago', password: '123456santiago' });
  if (login.status !== 201) throw new Error(`Login falló: ${JSON.stringify(login.body)}`);
  const token = login.body.token as string;
  const api = (metodo: 'get' | 'post' | 'patch' | 'put' | 'delete', ruta: string, cuerpo?: unknown) => {
    const r = http()[metodo](`/api${ruta}`).set('Authorization', `Bearer ${token}`);
    return cuerpo === undefined ? r : r.send(cuerpo as object);
  };
  return {
    app,
    http,
    token,
    api,
    base,
    cerrar: async () => {
      await app.close();
      const a = new Client({ connectionString: `${SERVIDOR}/postgres` });
      await a.connect();
      await a.query(`drop database if exists ${base} with (force)`);
      await a.end();
    },
  };
}
