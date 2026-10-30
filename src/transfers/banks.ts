// Entidades de otros bancos y billeteras a las que se puede enviar. Son nombres
// inventados ("Demo"): Banklite es un proyecto académico y no usa marcas reales.
export const EXTERNAL_BANKS = [
  'Banco Demo Cóndor',
  'Banco Demo Ceiba',
  'Banco Demo Guadua',
  'Banco Demo Frailejón',
  'Banco Demo Orquídea',
  'Billetera Demo Colibrí',
  'Billetera Demo Tucán',
  'Otra entidad',
] as const;

// En las billeteras el "número de cuenta" es el celular.
export const WALLETS: readonly string[] = ['Billetera Demo Colibrí', 'Billetera Demo Tucán'];

// Nombres que se usaron antes (marcas reales). Las solicitudes viejas los tienen
// guardados en destination_bank: al mostrarlas se traducen al nombre nuevo, y si
// un frontend viejo los manda todavía, se aceptan y se guardan con el nombre nuevo.
const LEGACY_BANKS: Readonly<Record<string, (typeof EXTERNAL_BANKS)[number]>> = {
  Bancolombia: 'Banco Demo Cóndor',
  'Banco de Bogotá': 'Banco Demo Ceiba',
  Davivienda: 'Banco Demo Guadua',
  'BBVA Colombia': 'Banco Demo Frailejón',
  'Banco de Occidente': 'Banco Demo Orquídea',
  Nequi: 'Billetera Demo Colibrí',
  DaviPlata: 'Billetera Demo Tucán',
};

/** Valores que acepta el DTO: los nombres vigentes y los antiguos. */
export const ACCEPTED_BANKS: readonly string[] = [...EXTERNAL_BANKS, ...Object.keys(LEGACY_BANKS)];

/** Nombre vigente de una entidad (traduce los nombres antiguos; el resto queda igual). */
export function currentBankName(name: string | null): string | null {
  return (name && LEGACY_BANKS[name]) || name;
}
