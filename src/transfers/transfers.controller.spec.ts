import { TRANSFER_MIN } from './dto/prepare-transfer.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { TransfersCatalogController } from './transfers-catalog.controller';
import { TransfersController } from './transfers.controller';
import { TransfersService } from './transfers.service';

describe('TransfersController', () => {
  const service = {
    list: jest.fn().mockResolvedValue(['t1']),
    prepare: jest.fn().mockResolvedValue({ id: 'req-1' }),
    confirm: jest.fn().mockResolvedValue({ status: 'completed' }),
    cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
  };
  const controller = new TransfersController(service as unknown as TransfersService);
  const request = { user: { idUser: 'user-1' }, accessToken: 'token-1' } as never;

  it('todas las rutas exigen sesión del cliente', () => {
    expect(Reflect.getMetadata('__guards__', TransfersController)).toContain(JwtAuthGuard);
  });

  it('cada ruta pasa al servicio el cliente de la sesión, nunca uno que venga en el cuerpo', async () => {
    const dto = { sourceAccountId: 's1' } as never;

    expect(await controller.list(request)).toEqual(['t1']);
    expect(service.list).toHaveBeenCalledWith('user-1');

    await controller.prepare(dto, request);
    expect(service.prepare).toHaveBeenCalledWith(dto, 'user-1');

    await controller.confirm('req-1', { dynamicCode: '123456' } as never, request);
    expect(service.confirm).toHaveBeenCalledWith('req-1', 'user-1', 'token-1', '123456');

    await controller.cancel('req-1', request);
    expect(service.cancel).toHaveBeenCalledWith('req-1', 'user-1');
  });

  it('el catálogo es público y publica el monto mínimo', () => {
    expect(Reflect.getMetadata('__guards__', TransfersCatalogController)).toBeUndefined();
    expect(new TransfersCatalogController().catalog()).toEqual({ min: TRANSFER_MIN });
  });
});
