import RAPIER from '@dimforge/rapier2d-compat'

let initPromise: Promise<typeof RAPIER> | null = null

export async function loadRapier(): Promise<typeof RAPIER> {
  if (!initPromise) {
    initPromise = RAPIER.init().then(() => RAPIER)
  }
  return initPromise
}

export type RapierModule = typeof RAPIER
