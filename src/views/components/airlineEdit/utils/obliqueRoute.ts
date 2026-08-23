/**
 * 功能名称：五向倾斜摄影二维航线规划
 * 日    期：2026/07/17
 */
import { calculatePlanarRoute, LocalPoint, PlanarRouteSegment } from './wayLineCalc';

export type FiveDirectionRouteKey = 'nadir' | 'direction1' | 'direction2' | 'direction3' | 'direction4';

export interface FiveDirectionRoutePlan {
	id: number;
	key: FiveDirectionRouteKey;
	label: string;
	headingDegrees?: number;
	gimbalPitchDegrees: number;
	segments: PlanarRouteSegment[];
}

export interface FiveDirectionRouteOptions {
	polygon: LocalPoint[];
	holes?: LocalPoint[][];
	maximumLineSpacing: number;
	footprintWidth: number;
	minimumGroundClearance: number;
	gimbalPitchDegrees: number;
	takeoffPoint?: LocalPoint;
	manualAngle?: number;
}

export interface FiveDirectionRouteResult {
	angle: number;
	lineSpacing: number;
	routes: FiveDirectionRoutePlan[];
}

interface RouteDefinition {
	id: number;
	key: FiveDirectionRouteKey;
	label: string;
	headingOffset?: number;
}

const ROUTE_DEFINITIONS: RouteDefinition[] = [
	{ id: 1, key: 'nadir', label: '1' },
	{ id: 2, key: 'direction1', label: '2', headingOffset: 0 },
	{ id: 3, key: 'direction2', label: '3', headingOffset: 90 },
	{ id: 4, key: 'direction3', label: '4', headingOffset: 180 },
	{ id: 5, key: 'direction4', label: '5', headingOffset: 270 },
];

/**
 * 使用正射最优角度或手动角度，生成俯拍及同步旋转的四组倾斜航线。
 */
export function calculateFiveDirectionRoutes(options: FiveDirectionRouteOptions): FiveDirectionRouteResult {
	if (!Number.isFinite(options.gimbalPitchDegrees) || options.gimbalPitchDegrees < -85 || options.gimbalPitchDegrees > -40) {
		throw new Error('倾斜摄影云台俯仰角必须在 -85° 到 -40°之间');
	}
	const pitchRadians = (Math.abs(options.gimbalPitchDegrees) * Math.PI) / 180;
	const horizontalOffset = options.minimumGroundClearance / Math.tan(pitchRadians);
	const holes = options.holes ?? [];
	const nadirPlan = calculatePlanarRoute({
		polygon: options.polygon,
		holes,
		maximumLineSpacing: options.maximumLineSpacing,
		footprintWidth: options.footprintWidth,
		takeoffPoint: options.takeoffPoint,
		manualAngle: options.manualAngle,
	});
	const routes: FiveDirectionRoutePlan[] = [];

	for (let definitionIndex = 0; definitionIndex < ROUTE_DEFINITIONS.length; definitionIndex++) {
		const definition = ROUTE_DEFINITIONS[definitionIndex];
		const headingDegrees = definition.headingOffset === undefined ? undefined : normalizeHeading(nadirPlan.angle + definition.headingOffset);
		let plan = nadirPlan;
		if (headingDegrees !== undefined) {
			const headingRadians = (headingDegrees * Math.PI) / 180;
			const eastOffset = -horizontalOffset * Math.sin(headingRadians);
			const northOffset = -horizontalOffset * Math.cos(headingRadians);
			const shiftedPolygon = shiftPolygon(options.polygon, eastOffset, northOffset);
			const shiftedHoles = holes.map((hole) => shiftPolygon(hole, eastOffset, northOffset));
			plan = calculatePlanarRoute({
				polygon: shiftedPolygon,
				holes: shiftedHoles,
				maximumLineSpacing: options.maximumLineSpacing,
				footprintWidth: options.footprintWidth,
				takeoffPoint: options.takeoffPoint,
				manualAngle: headingDegrees,
			});
		}
		routes.push({
			id: definition.id,
			key: definition.key,
			label: definition.label,
			headingDegrees,
			gimbalPitchDegrees: definition.key === 'nadir' ? -90 : options.gimbalPitchDegrees,
			segments: plan.segments,
		});
	}

	return {
		angle: nadirPlan.angle,
		lineSpacing: nadirPlan.lineSpacing,
		routes,
	};
}

/**
 * 将航向角归一化到 -180°~180°，保留正南方向为 180°。
 */
function normalizeHeading(angle: number): number {
	const normalized = ((angle % 360) + 360) % 360;
	return normalized > 180 ? normalized - 360 : normalized;
}

/**
 * 将测区在局部 ENU 平面按指定东西、南北距离平移。
 */
function shiftPolygon(polygon: LocalPoint[], eastOffset: number, northOffset: number): LocalPoint[] {
	const shifted: LocalPoint[] = [];
	for (let index = 0; index < polygon.length; index++) {
		shifted.push({
			x: polygon[index].x + eastOffset,
			y: polygon[index].y + northOffset,
		});
	}
	return shifted;
}
