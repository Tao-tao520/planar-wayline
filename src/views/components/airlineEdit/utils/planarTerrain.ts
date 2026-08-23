/**
 * 功能名称：面状航线地形与坐标工具
 * 日    期：2026/07/17
 */
import * as Cesium from 'cesium';
import { isPointInsidePolygonWithHoles, LocalPoint, PlanarRouteSegmentType } from './wayLineCalc';

const TERRAIN_SAMPLE_STEP = 30;
const TERRAIN_BATCH_SIZE = 1000;
const TERRAIN_SAMPLE_LEVEL = 14;

export interface LocalCoordinateFrame {
	toLocal: (position: Cesium.Cartesian3) => LocalPoint;
	toCartographic: (point: LocalPoint) => Cesium.Cartographic;
	toCartesian: (point: LocalPoint, height: number) => Cesium.Cartesian3;
}

export interface CartesianRouteSegment {
	type: PlanarRouteSegmentType;
	positions: Cesium.Cartesian3[];
	captureGroupId?: number;
}

export interface LocalRouteSegment {
	type: PlanarRouteSegmentType;
	points: LocalPoint[];
	captureGroupId?: number;
}

export interface RouteHeightOptions {
	heightType: number;
	lineHeight: number;
	absoluteFlightHeight?: number;
}

/**
 * 以测区包围球中心建立局部 ENU 坐标系。
 */
export function createLocalCoordinateFrame(positions: Cesium.Cartesian3[]): LocalCoordinateFrame {
	if (positions.length < 3) {
		throw new Error('测区至少需要 3 个顶点');
	}

	const boundingSphere = Cesium.BoundingSphere.fromPoints(positions);
	const origin = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(boundingSphere.center, new Cesium.Cartesian3());
	if (!origin) {
		throw new Error('无法建立测区局部坐标系');
	}

	const localToFixed = Cesium.Transforms.eastNorthUpToFixedFrame(origin);
	const fixedToLocal = Cesium.Matrix4.inverseTransformation(localToFixed, new Cesium.Matrix4());

	return {
		toLocal(position: Cesium.Cartesian3): LocalPoint {
			const local = Cesium.Matrix4.multiplyByPoint(fixedToLocal, position, new Cesium.Cartesian3());
			return { x: local.x, y: local.y };
		},
		toCartographic(point: LocalPoint): Cesium.Cartographic {
			const local = new Cesium.Cartesian3(point.x, point.y, 0);
			const fixed = Cesium.Matrix4.multiplyByPoint(localToFixed, local, new Cesium.Cartesian3());
			const cartographic = Cesium.Cartographic.fromCartesian(fixed);
			if (!cartographic) {
				throw new Error('局部坐标转换失败');
			}
			return cartographic;
		},
		toCartesian(point: LocalPoint, height: number): Cesium.Cartesian3 {
			const cartographic = this.toCartographic(point);
			return Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, height);
		},
	};
}

/**
 * 以固定网格采样整个测区并返回最高地形高度。
 */
export async function sampleMaximumTerrainHeight(viewer: Cesium.Viewer, frame: LocalCoordinateFrame, polygon: LocalPoint[], holes: LocalPoint[][] = []): Promise<number> {
	const samplePoints = createAreaSamplePoints(polygon, TERRAIN_SAMPLE_STEP, holes);
	const cartographics: Cesium.Cartographic[] = [];
	for (let index = 0; index < samplePoints.length; index++) {
		cartographics.push(frame.toCartographic(samplePoints[index]));
	}

	const heights = await sampleTerrainHeights(viewer, cartographics);
	let maximumHeight = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < heights.length; index++) {
		maximumHeight = Math.max(maximumHeight, heights[index]);
	}
	if (!Number.isFinite(maximumHeight)) {
		throw new Error('测区地形高度无效');
	}
	return maximumHeight;
}

/**
 * 沿实际航迹加密采样并返回最高地形高度。
 */
export async function sampleMaximumTerrainHeightAlongSegments(viewer: Cesium.Viewer, frame: LocalCoordinateFrame, segments: LocalRouteSegment[]): Promise<number> {
	const cartographics: Cesium.Cartographic[] = [];
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const points = densifyPolyline(segments[segmentIndex].points, TERRAIN_SAMPLE_STEP);
		for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
			cartographics.push(frame.toCartographic(points[pointIndex]));
		}
	}
	if (cartographics.length === 0) {
		throw new Error('航线缺少地形采样点');
	}

	const heights = await sampleTerrainHeights(viewer, cartographics);
	let maximumHeight = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < heights.length; index++) {
		maximumHeight = Math.max(maximumHeight, heights[index]);
	}
	if (!Number.isFinite(maximumHeight)) {
		throw new Error('航线地形高度无效');
	}
	return maximumHeight;
}

/**
 * 采样一个地理位置的地形高度。
 */
export async function sampleSingleTerrainHeight(viewer: Cesium.Viewer, position: Cesium.Cartographic): Promise<number> {
	const heights = await sampleTerrainHeights(viewer, [position]);
	return heights[0];
}

/**
 * 按高度模式生成 Cesium 航段；仿地模式每 30 米插值并采样一次地形。
 */
export async function createCartesianRouteSegments(
	viewer: Cesium.Viewer,
	frame: LocalCoordinateFrame,
	segments: LocalRouteSegment[],
	options: RouteHeightOptions,
): Promise<CartesianRouteSegment[]> {
	const localSegments: LocalRouteSegment[] = [];
	for (let index = 0; index < segments.length; index++) {
		const points = options.heightType === 3 ? densifyPolyline(segments[index].points, TERRAIN_SAMPLE_STEP) : [...segments[index].points];
		localSegments.push({ type: segments[index].type, points, captureGroupId: segments[index].captureGroupId });
	}

	if (options.heightType === 3) {
		return createTerrainFollowingSegments(viewer, frame, localSegments, options.lineHeight);
	}

	if (!Number.isFinite(options.absoluteFlightHeight)) {
		throw new Error('航线绝对高度无效');
	}

	const result: CartesianRouteSegment[] = [];
	for (let segmentIndex = 0; segmentIndex < localSegments.length; segmentIndex++) {
		const positions: Cesium.Cartesian3[] = [];
		const segment = localSegments[segmentIndex];
		for (let pointIndex = 0; pointIndex < segment.points.length; pointIndex++) {
			positions.push(frame.toCartesian(segment.points[pointIndex], options.absoluteFlightHeight!));
		}
		result.push({ type: segment.type, positions, captureGroupId: segment.captureGroupId });
	}
	return result;
}

/**
 * 计算所有三维航段总长度。
 */
export function calculateCartesianRouteLength(segments: CartesianRouteSegment[]): number {
	let length = 0;
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const positions = segments[segmentIndex].positions;
		for (let pointIndex = 0; pointIndex + 1 < positions.length; pointIndex++) {
			length += Cesium.Cartesian3.distance(positions[pointIndex], positions[pointIndex + 1]);
		}
	}
	return length;
}

/**
 * 批量请求最精细地形高度，任一点缺失时终止规划。
 */
async function sampleTerrainHeights(viewer: Cesium.Viewer, positions: Cesium.Cartographic[]): Promise<number[]> {
	const globe = viewer.scene.globe;
	const provider = globe.terrainProvider;
	if (provider instanceof Cesium.EllipsoidTerrainProvider) {
		throw new Error('当前地图未加载地形数据');
	}

	const heights: number[] = [];
	for (let start = 0; start < positions.length; start += TERRAIN_BATCH_SIZE) {
		const batch = positions.slice(start, start + TERRAIN_BATCH_SIZE);
		let sampled: Cesium.Cartographic[] = batch;
		try {
			if (provider.availability) {
				sampled = await Cesium.sampleTerrainMostDetailed(provider, batch);
			} else {
				sampled = await Cesium.sampleTerrain(provider, TERRAIN_SAMPLE_LEVEL, batch);
			}
		} catch {
			try {
				sampled = await Cesium.sampleTerrain(provider, TERRAIN_SAMPLE_LEVEL, batch);
			} catch {
				// 固定层级仍失败时继续读取已经加载到 Globe 的 Cesium 地形瓦片。
			}
		}

		for (let index = 0; index < batch.length; index++) {
			const sampledHeight = sampled[index]?.height;
			const cachedHeight = globe.getHeight(batch[index]);
			const height = Number.isFinite(sampledHeight) ? sampledHeight : cachedHeight;
			if (!Number.isFinite(height)) {
				throw new Error('当前 Cesium 地形未返回有效高度');
			}
			heights.push(height as number);
		}
	}
	return heights;
}

/**
 * 为导入航线批量采样地形高度。
 */
export async function sampleTerrainHeightsAtPositions(viewer: Cesium.Viewer, positions: Cesium.Cartographic[]): Promise<number[]> {
	return await sampleTerrainHeights(viewer, positions);
}

/**
 * 创建测区内部地形采样网格，并始终包含全部边界顶点。
 */
function createAreaSamplePoints(polygon: LocalPoint[], step: number, holes: LocalPoint[][] = []): LocalPoint[] {
	let minimumX = Number.POSITIVE_INFINITY;
	let maximumX = Number.NEGATIVE_INFINITY;
	let minimumY = Number.POSITIVE_INFINITY;
	let maximumY = Number.NEGATIVE_INFINITY;
	const result: LocalPoint[] = [];

	for (let index = 0; index < polygon.length; index++) {
		minimumX = Math.min(minimumX, polygon[index].x);
		maximumX = Math.max(maximumX, polygon[index].x);
		minimumY = Math.min(minimumY, polygon[index].y);
		maximumY = Math.max(maximumY, polygon[index].y);
		result.push(polygon[index]);

		const nextIndex = (index + 1) % polygon.length;
		const start = polygon[index];
		const end = polygon[nextIndex];
		const edgeLength = Math.hypot(end.x - start.x, end.y - start.y);
		const edgeIntervalCount = Math.max(1, Math.ceil(edgeLength / step));
		for (let interval = 1; interval < edgeIntervalCount; interval++) {
			const ratio = interval / edgeIntervalCount;
			result.push({
				x: start.x + (end.x - start.x) * ratio,
				y: start.y + (end.y - start.y) * ratio,
			});
		}
	}

	for (let x = minimumX + step / 2; x < maximumX; x += step) {
		for (let y = minimumY + step / 2; y < maximumY; y += step) {
			const point = { x, y };
			if (isPointInsidePolygonWithHoles(point, polygon, holes)) {
				result.push(point);
			}
		}
	}

	return result;
}

/**
 * 沿折线按固定距离加密，保留所有原始转折点。
 */
function densifyPolyline(points: LocalPoint[], step: number): LocalPoint[] {
	if (points.length < 2) {
		return [...points];
	}

	const result: LocalPoint[] = [points[0]];
	for (let index = 0; index + 1 < points.length; index++) {
		const start = points[index];
		const end = points[index + 1];
		const length = Math.hypot(end.x - start.x, end.y - start.y);
		const intervalCount = Math.max(1, Math.ceil(length / step));
		for (let interval = 1; interval <= intervalCount; interval++) {
			const ratio = interval / intervalCount;
			result.push({
				x: start.x + (end.x - start.x) * ratio,
				y: start.y + (end.y - start.y) * ratio,
			});
		}
	}
	return result;
}

/**
 * 为仿地航段批量采样地形并叠加固定离地高度。
 */
async function createTerrainFollowingSegments(
	viewer: Cesium.Viewer,
	frame: LocalCoordinateFrame,
	segments: LocalRouteSegment[],
	lineHeight: number,
): Promise<CartesianRouteSegment[]> {
	const cartographics: Cesium.Cartographic[] = [];
	const ranges: Array<{ start: number; length: number }> = [];

	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const rangeStart = cartographics.length;
		const points = segments[segmentIndex].points;
		for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
			cartographics.push(frame.toCartographic(points[pointIndex]));
		}
		ranges.push({ start: rangeStart, length: points.length });
	}

	const heights = await sampleTerrainHeights(viewer, cartographics);
	const result: CartesianRouteSegment[] = [];
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const range = ranges[segmentIndex];
		const positions: Cesium.Cartesian3[] = [];
		for (let pointIndex = 0; pointIndex < range.length; pointIndex++) {
			const localPoint = segments[segmentIndex].points[pointIndex];
			const height = heights[range.start + pointIndex] + lineHeight;
			positions.push(frame.toCartesian(localPoint, height));
		}
		result.push({ type: segments[segmentIndex].type, positions, captureGroupId: segments[segmentIndex].captureGroupId });
	}
	return result;
}
