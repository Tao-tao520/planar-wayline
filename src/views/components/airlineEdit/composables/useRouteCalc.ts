/**
 * 功能名称：面状航线计算工具函数
 * 日    期：2026/07/29
 */
import * as Cesium from 'cesium';
import globeConfig from '../config/planarConfig';
import { LocalPoint, PlanarRouteSegment } from '../utils/wayLineCalc';
import {
	calculateCartesianRouteLength,
	CartesianRouteSegment,
	LocalCoordinateFrame,
	sampleMaximumTerrainHeight,
	sampleSingleTerrainHeight,
} from '../utils/planarTerrain';

interface FlightHeightResult {
	minimumGroundClearance: number;
	absoluteFlightHeight?: number;
}

interface RouteConnectionResult {
	segments: CartesianRouteSegment[];
	climbLength: number;
}

/**
 * 按起飞速度和全局速度计算单组航线预计时长。
 */
export function calculateRouteDuration(totalLength: number, climbLength: number): number {
	const takeoffSpeed = Math.max(0.1, Number(globeConfig.takeoffSpeed));
	const flightSpeed = Math.max(0.1, Number(globeConfig.speed));
	return climbLength / takeoffSpeed + Math.max(0, totalLength - climbLength) / flightSpeed;
}

/**
 * 将秒数格式化为侧边航线统计文本。
 */
export function formatRouteDuration(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const remainingSeconds = Math.round(seconds % 60);
	if (hours > 0) {
		return `${hours} h ${minutes} m ${remainingSeconds} s`;
	}
	return `${minutes} m ${remainingSeconds} s`;
}

/**
 * 根据高度模式计算统一行距使用的最小离地高度。
 */
export async function resolveFlightHeight(viewer: Cesium.Viewer, frame: LocalCoordinateFrame, polygon: LocalPoint[], holes: LocalPoint[][] = []): Promise<FlightHeightResult> {
	const lineHeight = Number(globeConfig.lineHeight);
	if (!Number.isFinite(lineHeight) || lineHeight <= 0) {
		throw new Error('航线高度无效');
	}

	if (Number(globeConfig.heightType) === 3) {
		return { minimumGroundClearance: lineHeight };
	}

	const maximumTerrainHeight = await sampleMaximumTerrainHeight(viewer, frame, polygon, holes);
	let absoluteFlightHeight = lineHeight;
	if (Number(globeConfig.heightType) === 2) {
		if (!globeConfig.flyPosition) {
			throw new Error('请先设置参考起飞点');
		}
		const takeoffCartographic = Cesium.Cartographic.fromCartesian(globeConfig.flyPosition);
		if (!takeoffCartographic) {
			throw new Error('参考起飞点无效');
		}
		const takeoffTerrainHeight = await sampleSingleTerrainHeight(viewer, takeoffCartographic);
		absoluteFlightHeight = takeoffTerrainHeight + lineHeight;
	}

	return {
		minimumGroundClearance: absoluteFlightHeight - maximumTerrainHeight,
		absoluteFlightHeight,
	};
}

/**
 * 从参考起飞点垂直爬升到首航点海拔，再等高连接到第一个飞行航点。
 */
export function connectTakeoffToFirstWaypoint(segments: CartesianRouteSegment[]): RouteConnectionResult {
	if (!globeConfig.flyPosition) {
		return { segments, climbLength: 0 };
	}

	let firstWaypoint: Cesium.Cartesian3 | null = null;
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		if (segments[segmentIndex].positions.length > 0) {
			firstWaypoint = segments[segmentIndex].positions[0];
			break;
		}
	}
	if (!firstWaypoint || Cesium.Cartesian3.distanceSquared(globeConfig.flyPosition, firstWaypoint) <= Cesium.Math.EPSILON7) {
		return { segments, climbLength: 0 };
	}
	const takeoffCartographic = Cesium.Cartographic.fromCartesian(globeConfig.flyPosition);
	const firstWaypointCartographic = Cesium.Cartographic.fromCartesian(firstWaypoint);
	if (!takeoffCartographic || !firstWaypointCartographic) {
		throw new Error('起飞点或首航点坐标无效');
	}
	const climbCompletedPoint = Cesium.Cartesian3.fromRadians(takeoffCartographic.longitude, takeoffCartographic.latitude, firstWaypointCartographic.height);
	const connectionPositions: Cesium.Cartesian3[] = [globeConfig.flyPosition];
	if (Cesium.Cartesian3.distanceSquared(globeConfig.flyPosition, climbCompletedPoint) > Cesium.Math.EPSILON7) {
		connectionPositions.push(climbCompletedPoint);
	}
	if (Cesium.Cartesian3.distanceSquared(connectionPositions[connectionPositions.length - 1], firstWaypoint) > Cesium.Math.EPSILON7) {
		connectionPositions.push(firstWaypoint);
	}
	if (connectionPositions.length < 2) {
		return { segments, climbLength: 0 };
	}

	return {
		segments: [
			{
				type: 'transit',
				positions: connectionPositions,
			},
			...segments,
		],
		climbLength: Cesium.Cartesian3.distance(globeConfig.flyPosition, climbCompletedPoint),
	};
}

/**
 * 获取局部二维航线的第一个有效轨迹点。
 */
export function getFirstLocalRoutePoint(segments: PlanarRouteSegment[]): LocalPoint | null {
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		if (segments[segmentIndex].points.length > 0) {
			return segments[segmentIndex].points[0];
		}
	}
	return null;
}

/**
 * 获取三维航线的第一个有效轨迹点。
 */
export function getFirstCartesianRoutePoint(segments: CartesianRouteSegment[]): Cesium.Cartesian3 | null {
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		if (segments[segmentIndex].positions.length > 0) {
			return segments[segmentIndex].positions[0];
		}
	}
	return null;
}

/**
 * 按司空拍照块规则统计当前航线照片数量。
 */
export function calculateRoutePhotoCount(segments: CartesianRouteSegment[], photoDistance: number, splitCaptureGroups: boolean): number {
	if (!Number.isFinite(photoDistance) || photoDistance <= 0) {
		throw new Error('自动拍照距离无效');
	}
	if (!splitCaptureGroups) {
		const routeLength = calculateCartesianRouteLength(segments);
		return routeLength > 0 ? Math.floor(routeLength / photoDistance) + 1 : 0;
	}

	const captureLengths = new Map<number, number>();
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const captureGroupId = segments[segmentIndex].captureGroupId;
		if (captureGroupId === undefined) {
			continue;
		}
		const previousLength = captureLengths.get(captureGroupId) ?? 0;
		captureLengths.set(captureGroupId, previousLength + calculateCartesianRouteLength([segments[segmentIndex]]));
	}

	let photoCount = 0;
	const lengths = captureLengths.values();
	for (const length of lengths) {
		if (length > 0) {
			photoCount += Math.floor(length / photoDistance) + 1;
		}
	}
	if (captureLengths.size === 0) {
		const routeLength = calculateCartesianRouteLength(segments);
		return routeLength > 0 ? Math.floor(routeLength / photoDistance) + 1 : 0;
	}
	return photoCount;
}

/**
 * 将三维航段保存为现有扁平坐标结构，供后续导出重做时使用。
 */
export function flattenRouteCoordinates(segments: CartesianRouteSegment[]): number[] {
	const result: number[] = [];
	let previousPosition: Cesium.Cartesian3 | null = null;
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const positions = segments[segmentIndex].positions;
		for (let pointIndex = 0; pointIndex < positions.length; pointIndex++) {
			if (previousPosition && Cesium.Cartesian3.distanceSquared(previousPosition, positions[pointIndex]) <= Cesium.Math.EPSILON7) {
				continue;
			}
			const cartographic = Cesium.Cartographic.fromCartesian(positions[pointIndex]);
			if (!cartographic) {
				continue;
			}
			result.push(Cesium.Math.toDegrees(cartographic.longitude));
			result.push(Cesium.Math.toDegrees(cartographic.latitude));
			result.push(cartographic.height);
			previousPosition = positions[pointIndex];
		}
	}
	return result;
}
