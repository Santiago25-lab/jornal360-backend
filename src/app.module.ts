import { Controller, Get, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AuditoriaService } from './common/auditoria.service';
import { AuthGuard, FiltroErrores, Publico } from './common/comun';
import { config } from './config';
import { Db } from './db/db.service';
import { AuthController, AuthService, UsuariosController } from './modules/auth/auth';
import {
  ConceptosController,
  ConceptosService,
  EmpresaController,
  EmpresaService,
  FestivosController,
  FormatosController,
  ParametrosController,
  ParametrosService,
  RespaldoController,
  RespaldoService,
  TablasController,
} from './modules/configuracion/configuracion';
import { ContextoService } from './modules/configuracion/contexto.service';
import { ESTRUCTURA_CONTROLLERS } from './modules/configuracion/estructura';
import { SectorPublicoController, SectorPublicoService } from './modules/configuracion/sector-publico';
import { EmpleadosController, EmpleadosService } from './modules/empleados/empleados';
import { MODULOS_OPERACION } from './modules/operacion';

@Controller()
class SaludController {
  constructor(private readonly db: Db) {}

  @Publico()
  @Get('salud')
  async salud() {
    await this.db.one('select 1 as ok');
    return { estado: 'ok', servicio: 'Jornal 360', hora: new Date().toISOString() };
  }
}

@Module({
  imports: [JwtModule.register({ secret: config().jwtSecreto })],
  controllers: [
    SaludController,
    AuthController,
    UsuariosController,
    EmpresaController,
    ParametrosController,
    TablasController,
    FestivosController,
    ConceptosController,
    FormatosController,
    RespaldoController,
    SectorPublicoController,
    ...ESTRUCTURA_CONTROLLERS,
    EmpleadosController,
    ...MODULOS_OPERACION.controllers,
  ],
  providers: [
    Db,
    AuditoriaService,
    ContextoService,
    AuthService,
    EmpresaService,
    ParametrosService,
    ConceptosService,
    RespaldoService,
    SectorPublicoService,
    EmpleadosService,
    ...MODULOS_OPERACION.providers,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: FiltroErrores },
  ],
})
export class AppModule {}
