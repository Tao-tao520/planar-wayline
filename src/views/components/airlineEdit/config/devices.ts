/**
 * 机型与广角镜头参数。
 * 机型枚举、负载枚举、镜头尺寸和智能摆拍能力来自司空航线编辑器的机型表。
 */
import { MappingLens } from './cameraConfig';

export type WaylineKindId = 'planar' | 'strip' | 'facade' | 'solid' | 'mappingObject';

export interface WaylineKindOption {
	id: WaylineKindId;
	name: string;
	editable: boolean;
}

export interface AircraftModel {
	id: string;
	name: string;
	seriesId: number;
	droneEnumValue: number;
	droneSubEnumValue: number;
	payloadEnumValue: number;
	wideCamera: MappingLens;
	supportsSmartOblique: boolean;
}

export interface AircraftSeries {
	id: number;
	name: string;
	models: AircraftModel[];
}

const WIDE_M30: MappingLens = { focalLengthMm: 4.5, sensorWidthMm: 6.4, sensorHeightMm: 4.8, imageWidthPx: 4000, imageHeightPx: 3000 };
const WIDE_M3T: MappingLens = { focalLengthMm: 4.55, sensorWidthMm: 6.4, sensorHeightMm: 4.8, imageWidthPx: 4000, imageHeightPx: 3000 };
const WIDE_SURVEY: MappingLens = { focalLengthMm: 12.29, sensorWidthMm: 17.42, sensorHeightMm: 13.06, imageWidthPx: 5280, imageHeightPx: 3956 };
const WIDE_M4T: MappingLens = { focalLengthMm: 6.73, sensorWidthMm: 9.65, sensorHeightMm: 7.24, imageWidthPx: 4032, imageHeightPx: 3024 };
const WIDE_M5: MappingLens = { focalLengthMm: 8.67, sensorWidthMm: 13.1, sensorHeightMm: 9.8, imageWidthPx: 4096, imageHeightPx: 3072 };

export const WAYLINE_KINDS: WaylineKindOption[] = [
	{ id: 'planar', name: '面状航线', editable: true },
	{ id: 'strip', name: '带状航线', editable: false },
	{ id: 'facade', name: '斜面航线', editable: false },
	{ id: 'solid', name: '几何体航线', editable: false },
	{ id: 'mappingObject', name: '贴近摄影', editable: false },
];

export const DEFAULT_AIRCRAFT_ID = 'm4td';

export const AIRCRAFT_SERIES: AircraftSeries[] = [
	{
		id: 67,
		name: '经纬 M30 系列',
		models: [
			model('m30', '经纬 M30', 67, 0, 52, WIDE_M30, false),
			model('m30t', '经纬 M30 T', 67, 1, 53, WIDE_M30, false),
		],
	},
	{
		id: 77,
		name: 'Mavic 3 行业系列',
		models: [
			model('m3e', 'Mavic 3E', 77, 0, 66, WIDE_SURVEY, true),
			model('m3t', 'Mavic 3T', 77, 1, 67, WIDE_M3T, false),
			model('m3ta', 'Mavic 3TA', 77, 3, 129, WIDE_M3T, false),
		],
	},
	{
		id: 91,
		name: 'Matrice 3D 系列',
		models: [
			model('m3d', 'Matrice 3D', 91, 0, 80, WIDE_SURVEY, true),
			model('m3td', 'Matrice 3TD', 91, 1, 81, WIDE_M3T, false),
		],
	},
	{
		id: 99,
		name: 'Matrice 4 行业系列',
		models: [
			model('m4e', 'Matrice 4E', 99, 0, 88, WIDE_SURVEY, true),
			model('m4t', 'Matrice 4T', 99, 1, 89, WIDE_M4T, true),
		],
	},
	{
		id: 100,
		name: 'Matrice 4D 系列',
		models: [
			model('m4d', 'Matrice 4D', 100, 0, 98, WIDE_SURVEY, true),
			model('m4td', 'Matrice 4TD', 100, 1, 99, WIDE_M4T, true),
		],
	},
	{
		id: 130,
		name: 'Matrice 5D 系列',
		models: [model('m5td', 'Matrice 5TD', 130, 0, 122, WIDE_M5, true)],
	},
	{
		id: 139,
		name: 'Matrice 5T',
		models: [model('m5t', 'Matrice 5T', 139, 0, 128, WIDE_M5, true)],
	},
];

function model(
	id: string,
	name: string,
	seriesId: number,
	droneSubEnumValue: number,
	payloadEnumValue: number,
	wideCamera: MappingLens,
	supportsSmartOblique: boolean,
): AircraftModel {
	return {
		id,
		name,
		seriesId,
		droneEnumValue: seriesId,
		droneSubEnumValue,
		payloadEnumValue,
		wideCamera,
		supportsSmartOblique,
	};
}

export function findAircraft(modelId: string): AircraftModel | undefined {
	for (let seriesIndex = 0; seriesIndex < AIRCRAFT_SERIES.length; seriesIndex++) {
		const models = AIRCRAFT_SERIES[seriesIndex].models;
		for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
			if (models[modelIndex].id === modelId) {
				return models[modelIndex];
			}
		}
	}
	return undefined;
}

export function findSeries(seriesId: number): AircraftSeries | undefined {
	return AIRCRAFT_SERIES.find((series) => series.id === seriesId);
}
