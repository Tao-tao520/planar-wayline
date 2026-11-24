/**
 * 当前航线使用的机型。默认 Matrice 4TD。
 */
import { ref } from 'vue';
import { AircraftModel, DEFAULT_AIRCRAFT_ID, findAircraft } from './devices';

const STORAGE_KEY = 'planarAircraft';

export const selectedAircraftId = ref(readStoredAircraftId());

export function getSelectedAircraft(): AircraftModel {
	return findAircraft(selectedAircraftId.value) ?? findAircraft(DEFAULT_AIRCRAFT_ID)!;
}

export function selectAircraft(modelId: string): void {
	if (!findAircraft(modelId)) {
		return;
	}
	selectedAircraftId.value = modelId;
	sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ modelId }));
}

export function hasStoredAircraft(): boolean {
	return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(STORAGE_KEY) !== null;
}

function readStoredAircraftId(): string {
	if (typeof sessionStorage === 'undefined') {
		return DEFAULT_AIRCRAFT_ID;
	}
	const raw = sessionStorage.getItem(STORAGE_KEY);
	if (!raw) {
		return DEFAULT_AIRCRAFT_ID;
	}
	try {
		const parsed = JSON.parse(raw) as { modelId?: string };
		if (parsed.modelId && findAircraft(parsed.modelId)) {
			return parsed.modelId;
		}
	} catch {
		return DEFAULT_AIRCRAFT_ID;
	}
	return DEFAULT_AIRCRAFT_ID;
}
