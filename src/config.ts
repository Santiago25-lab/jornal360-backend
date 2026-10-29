/** Configuración por variables de entorno (ver .env.example). */
export interface Config {
  puerto: number;
  databaseUrl: string;
  databaseSsl: boolean;
  jwtSecreto: string;
  jwtHoras: number;
  qrSecreto: string;
  origenesCors: string[];
  superadminUsuario: string;
  superadminPassword: string;
  /** Administrador de la plataforma (por encima de todas las empresas). Sin contraseña no se crea. */
  plataformaUsuario: string;
  plataformaPassword: string | null;
  migrarAlIniciar: boolean;
  /** Desfase horario de Colombia en minutos (UTC-5, sin horario de verano). */
  desfaseMinutos: number;
  urlFrontend: string;
}

let cache: Config | null = null;

export function config(): Config {
  if (cache) return cache;
  const env = process.env;
  const produccion = env.NODE_ENV === 'production';
  const jwt = env.JWT_SECRETO ?? (produccion ? '' : 'desarrollo-jwt-cambiar');
  const qr = env.QR_SECRETO ?? (produccion ? '' : 'desarrollo-qr-cambiar');
  if (produccion && (!jwt || !qr)) throw new Error('Defina JWT_SECRETO y QR_SECRETO en producción');
  cache = {
    puerto: Number(env.PORT ?? 3001),
    databaseUrl: env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/jornal_dev',
    databaseSsl: (env.DATABASE_SSL ?? (produccion ? 'true' : 'false')) === 'true',
    jwtSecreto: jwt,
    jwtHoras: Number(env.JWT_HORAS ?? 12),
    qrSecreto: qr,
    origenesCors: (env.CORS_ORIGENES ?? 'http://localhost:3000').split(',').map((s) => s.trim()).filter(Boolean),
    superadminUsuario: env.SUPERADMIN_USUARIO ?? 'Santiago',
    superadminPassword: env.SUPERADMIN_PASSWORD ?? '123456santiago',
    plataformaUsuario: env.PLATAFORMA_USUARIO ?? 'Santiago',
    plataformaPassword: env.PLATAFORMA_PASSWORD || null,
    migrarAlIniciar: (env.MIGRAR_AL_INICIAR ?? 'true') === 'true',
    desfaseMinutos: Number(env.DESFASE_MINUTOS ?? -300),
    urlFrontend: env.URL_FRONTEND ?? 'http://localhost:3000',
  };
  return cache;
}

/** Solo para pruebas. */
export function reiniciarConfig() {
  cache = null;
}
