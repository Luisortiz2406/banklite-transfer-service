import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { JwtAuthGuard } from './jwt-auth.guard';

const SECRET = 'secreto-de-clientes-para-pruebas-0123456789';
const jwt = new JwtService({});
const guard = new JwtAuthGuard(jwt, new ConfigService({ JWT_SECRET: SECRET }));

function contextFor(authorization?: string) {
  const request: { headers: Record<string, string>; user?: unknown; accessToken?: string } = {
    headers: authorization ? { authorization } : {},
  };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
  return { context, request };
}
const sign = (payload: Record<string, unknown>, secret = SECRET, options: Record<string, unknown> = {}) =>
  jwt.sign(payload, { secret, algorithm: 'HS256', ...options });

describe('JwtAuthGuard (token de acceso del cliente)', () => {
  it('con un token de acceso válido deja al cliente y su token en la petición', () => {
    const accessToken = sign({ sub: 'user-1', type: 'access' });
    const { context, request } = contextFor(`Bearer ${accessToken}`);

    expect(guard.canActivate(context)).toBe(true);
    expect(request.user).toEqual({ idUser: 'user-1' });
    expect(request.accessToken).toBe(accessToken);
  });

  it('sin cabecera Bearer da 401', () => {
    expect(() => guard.canActivate(contextFor().context)).toThrow('Token no proporcionado');
    expect(() => guard.canActivate(contextFor('Basic abc').context)).toThrow(UnauthorizedException);
  });

  it('rechaza un token de otro tipo (refresh, empleado), sin sub, de otro secreto o vencido', () => {
    const rejected = [
      sign({ sub: 'user-1', type: 'refresh' }),
      sign({ sub: 'user-1', type: 'staff' }),
      sign({ type: 'access' }),
      sign({ sub: 'user-1', type: 'access' }, 'otro-secreto-distinto-de-32-caracteres!!'),
      sign({ sub: 'user-1', type: 'access' }, SECRET, { expiresIn: -10 }),
      'no.es.jwt',
    ];
    for (const token of rejected) {
      expect(() => guard.canActivate(contextFor(`Bearer ${token}`).context)).toThrow('Token inválido o expirado');
    }
  });
});
