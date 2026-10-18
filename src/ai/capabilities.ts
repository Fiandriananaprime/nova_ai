export interface ProviderCapabilities {
  id: string;
  transport: 'web-browser' | 'local-mock';
  implemented: boolean;
  requiresManualLogin: boolean;
  supportsResume: boolean;
  note: string;
}

export const PROVIDER_CAPABILITIES: ProviderCapabilities[] = [
  { id: 'chatgpt-web', transport: 'web-browser', implemented: true, requiresManualLogin: true, supportsResume: true, note: 'Sélecteurs web sujets aux changements ; validation en direct requise sur la machine utilisateur.' },
  { id: 'claude-web', transport: 'web-browser', implemented: false, requiresManualLogin: true, supportsResume: false, note: 'Adaptateur réservé, non implémenté.' },
  { id: 'gemini-web', transport: 'web-browser', implemented: false, requiresManualLogin: true, supportsResume: false, note: 'Adaptateur réservé, non implémenté.' },
  { id: 'mock', transport: 'local-mock', implemented: true, requiresManualLogin: false, supportsResume: true, note: 'Réponses de test déterministes ; ne corrige pas réellement un projet.' },
];
