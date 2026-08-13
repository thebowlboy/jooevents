import { createContext } from 'svelte';
import type { OrganizerFormsPort } from './view-models/intake-forms';

/** Feature-local rejoin seam. The root composition alone chooses sample or live. */
export const [useOrganizerFormsPort, setOrganizerFormsPort] = createContext<OrganizerFormsPort>();
