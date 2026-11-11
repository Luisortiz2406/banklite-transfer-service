// Entidades de otros bancos y billeteras a las que se puede enviar. Son nombres
// ficticios: Banklite es un proyecto académico y no usa marcas reales, y ninguno
// corresponde a un banco o billetera real de Colombia.
export const EXTERNAL_BANKS = [
  'Banco Cordillera',
  'Banco Guayacán',
  'Banco Altamar',
  'Banco Meridiano',
  'Banco Sabanal',
  'Billetera Pulso',
  'Billetera Brío',
  'Otra entidad',
] as const;

// En las billeteras el "número de cuenta" es el celular.
export const WALLETS: readonly string[] = ['Billetera Pulso', 'Billetera Brío'];

// Nombres que se usaron antes: marcas reales y, después, los nombres "Demo".
// Las solicitudes viejas los tienen guardados en destination_bank: al mostrarlas
// se traducen al nombre vigente, y si un frontend viejo los manda todavía, se
// aceptan y se guardan con el nombre vigente.
const LEGACY_BANKS: Readonly<Record<string, (typeof EXTERNAL_BANKS)[number]>> = {
  Bancolombia: 'Banco Cordillera',
  'Banco de Bogotá': 'Banco Guayacán',
  Davivienda: 'Banco Altamar',
  'BBVA Colombia': 'Banco Meridiano',
  'Banco de Occidente': 'Banco Sabanal',
  Nequi: 'Billetera Pulso',
  DaviPlata: 'Billetera Brío',
  'Banco Demo Cóndor': 'Banco Cordillera',
  'Banco Demo Ceiba': 'Banco Guayacán',
  'Banco Demo Guadua': 'Banco Altamar',
  'Banco Demo Frailejón': 'Banco Meridiano',
  'Banco Demo Orquídea': 'Banco Sabanal',
  'Billetera Demo Colibrí': 'Billetera Pulso',
  'Billetera Demo Tucán': 'Billetera Brío',
};

/** Valores que acepta el DTO: los nombres vigentes y los antiguos. */
export const ACCEPTED_BANKS: readonly string[] = [...EXTERNAL_BANKS, ...Object.keys(LEGACY_BANKS)];

/** Nombre vigente de una entidad (traduce los nombres antiguos; el resto queda igual). */
export function currentBankName(name: string | null): string | null {
  return (name && LEGACY_BANKS[name]) || name;
}
