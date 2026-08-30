import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Le nœud Hardhat local (127.0.0.1:8545) n'envoie pas d'en-têtes CORS
  // autorisant l'origine http://localhost:3000, donc le navigateur bloque
  // tout `eth_call` en preflight (« échec de la requête CORS », statut
  // null). On reroute les appels RPC hardhat par le serveur Next, même
  // origine que la page, ce qui supprime le CORS. Voir `config/index.ts`
  // pour le transport `/rpc/hardhat` côté client.
  async rewrites() {
    return [
      { source: "/rpc/hardhat", destination: "http://127.0.0.1:8545" },
    ];
  },
};

export default nextConfig;
