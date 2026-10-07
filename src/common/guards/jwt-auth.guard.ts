import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('Token no proporcionado');
    try {
      const token = header.slice('Bearer '.length);
      const payload = this.jwt.verify(token, { secret: this.config.get<string>('JWT_SECRET'), algorithms: ['HS256'] });
      if (payload.type !== 'access' || !payload.sub) throw new UnauthorizedException();
      (request as any).user = { idUser: payload.sub };
      (request as any).accessToken = token;
      return true;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }
}