import Panel from '@/components/Panel';

/**
 * Etat « mandat sans gestionnaire » — le mandat existe mais aucun gestionnaire n'a ete
 * enregistre pour l'epoque courante.
 *
 * Cas nominal de la premiere epoque : pas encore d'enchere, le pool tourne au tarif de base,
 * tout fonctionne. Ton neutre : ce n'est pas un echec, `danger` induirait l'utilisateur en erreur.
 */
export function MandateNoManagerState() {
  return (
    <Panel className="max-w-lg">
      <div
        role="status"
        aria-live="polite"
        className="flex items-start gap-4 min-w-0"
      >
        <div className="flex flex-col gap-1 min-w-0">
          <h3 className="text-h4 font-medium text-cloud">No manager for the current epoch</h3>
          <p className="text-body text-cloud/70">
            The pool trades at the base fee. A new auction will pick a manager
            before the next epoch starts.
          </p>
        </div>
      </div>
    </Panel>
  );
}
