/** Nombres de espacio: la parte final de la dirección por la que entra cada empresa (jornal360…/<espacio>). */

/** Rutas del sistema: un espacio no puede llamarse igual. */
export const ESPACIOS_RESERVADOS = new Set([
  'api', 'plataforma', 'login', 'inicio', 'empleados', 'asistencia', 'novedades', 'nomina', 'prestaciones', 'retiros', 'reportes',
  'configuracion', 'asistente', 'ayuda', 'liquidador', 'marcar', 'vincular', 'kiosco', 'pantalla-qr', 'salud', 'publico', 'admin', 'soporte',
]);

/** "Alcaldía de Pasto" → "alcaldia-de-pasto". */
export function aEspacio(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export const FORMATO_ESPACIO = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Devuelve el error para mostrar, o null si el nombre sirve. */
export function errorEspacio(espacio: string): string | null {
  if (!FORMATO_ESPACIO.test(espacio)) return 'Use solo letras minúsculas, números y guiones (máximo 40), sin espacios ni tildes';
  if (ESPACIOS_RESERVADOS.has(espacio)) return `"${espacio}" es una palabra reservada del sistema; elija otro nombre`;
  return null;
}
