export type ReadSource = {
  message: string;
  error: Error | null | undefined;
};

// Les deux niveaux d'echec de useReadContracts (erreur de requete globale vs data[i].error)
// ne se chevauchent jamais : une requete morte laisse data undefined. Aucun dedoublonnage requis.
export function collectReadErrors(sources: ReadSource[]): ReadSource[] {
  return sources.filter((source) => source.error);
}
