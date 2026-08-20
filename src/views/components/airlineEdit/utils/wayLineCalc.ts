/**
 * 功能名称：面状航线二维规划器
 * 日    期：2026/07/17
 */

const EPSILON = 1e-7;
const MIN_TURN_PENALTY = 5;

export interface LocalPoint {
	x: number;
	y: number;
}

export type PlanarRouteSegmentType = 'scan' | 'transit';

export interface PlanarRouteSegment {
	type: PlanarRouteSegmentType;
	points: LocalPoint[];
	captureGroupId?: number;
}

export interface PlanarRoutePlan {
	angle: number;
	lineSpacing: number;
	scanLength: number;
	transitLength: number;
	totalLength: number;
	turnCount: number;
	entryDistance: number;
	score: number;
	segments: PlanarRouteSegment[];
}

export interface PlanarRouteOptions {
	polygon: LocalPoint[];
	holes?: LocalPoint[][];
	maximumLineSpacing: number;
	footprintWidth: number;
	takeoffPoint?: LocalPoint;
	manualAngle?: number;
}

interface RotatedPoint {
	along: number;
	cross: number;
}

interface ScanInterval {
	start: LocalPoint;
	end: LocalPoint;
	startAlong: number;
	endAlong: number;
	captureGroupId: number;
}

interface ScanRow {
	cross: number;
	intervals: ScanInterval[];
}

/**
 * 根据相机覆盖宽度和旁向重叠率计算最大允许行距。
 */
export function calculateMaximumLineSpacing(minimumGroundClearance: number, horizontalFovDegrees: number, sideOverlapPercent: number): number {
	if (!Number.isFinite(minimumGroundClearance) || minimumGroundClearance <= 0) {
		throw new Error('最小离地高度必须大于 0');
	}
	if (!Number.isFinite(horizontalFovDegrees) || horizontalFovDegrees <= 0 || horizontalFovDegrees >= 180) {
		throw new Error('相机水平视场角无效');
	}
	if (!Number.isFinite(sideOverlapPercent) || sideOverlapPercent < 0 || sideOverlapPercent >= 100) {
		throw new Error('旁向重叠率无效');
	}

	const halfFovRadians = (horizontalFovDegrees * Math.PI) / 360;
	const footprintWidth = 2 * minimumGroundClearance * Math.tan(halfFovRadians);
	return footprintWidth * (1 - sideOverlapPercent / 100);
}

/**
 * 根据相机纵向覆盖范围和航向重叠率计算自动拍照距离。
 */
export function calculatePhotoDistance(minimumGroundClearance: number, verticalFovDegrees: number, forwardOverlapPercent: number): number {
	if (!Number.isFinite(minimumGroundClearance) || minimumGroundClearance <= 0) {
		throw new Error('最小离地高度必须大于 0');
	}
	if (!Number.isFinite(verticalFovDegrees) || verticalFovDegrees <= 0 || verticalFovDegrees >= 180) {
		throw new Error('相机垂直视场角无效');
	}
	if (!Number.isFinite(forwardOverlapPercent) || forwardOverlapPercent < 0 || forwardOverlapPercent >= 100) {
		throw new Error('航向重叠率无效');
	}

	const halfFovRadians = (verticalFovDegrees * Math.PI) / 360;
	const footprintLength = 2 * minimumGroundClearance * Math.tan(halfFovRadians);
	return footprintLength * (1 - forwardOverlapPercent / 100);
}

/**
 * 生成正射面状航线。自动模式比较多边形边方向，手动模式固定使用传入角度。
 */
export function calculatePlanarRoute(options: PlanarRouteOptions): PlanarRoutePlan {
	validateOptions(options);

	const holes = options.holes ?? [];
	const angles = options.manualAngle === undefined ? collectCandidateAngles(options.polygon) : [normalizeAxisAngle(options.manualAngle)];
	let bestPlan: PlanarRoutePlan | null = null;

	for (let index = 0; index < angles.length; index++) {
		const angle = angles[index];
		const plan = calculatePlanForAngle(options, holes, angle);
		if (!plan) {
			continue;
		}
		if (!bestPlan || plan.score < bestPlan.score) {
			bestPlan = plan;
		}
	}

	if (!bestPlan) {
		throw new Error('当前测区无法生成有效航线');
	}

	return bestPlan;
}

/**
 * 判断点是否位于带洞多边形内部（外环内且不在任何洞内，各环边界视为有效面）。
 */
export function isPointInsidePolygonWithHoles(point: LocalPoint, polygon: LocalPoint[], holes: LocalPoint[][]): boolean {
	if (!isPointInsidePolygon(point, polygon)) {
		return false;
	}
	for (let holeIndex = 0; holeIndex < holes.length; holeIndex++) {
		if (isPointStrictlyInsideRing(point, holes[holeIndex])) {
			return false;
		}
	}
	return true;
}

/**
 * 判断点是否严格位于环内部（不含边界）。
 */
export function isPointStrictlyInsideRing(point: LocalPoint, ring: LocalPoint[]): boolean {
	if (isPointOnRingBoundary(point, ring)) {
		return false;
	}
	return isPointInsidePolygon(point, ring);
}

/**
 * 判断点是否位于环的某条边上。
 */
export function isPointOnRingBoundary(point: LocalPoint, ring: LocalPoint[]): boolean {
	for (let index = 0; index < ring.length; index++) {
		const nextIndex = (index + 1) % ring.length;
		if (isPointOnSegment(point, ring[index], ring[nextIndex])) {
			return true;
		}
	}
	return false;
}

/**
 * 校验挖孔环集合：环必须完全位于测区内部且互不重叠。
 */
export function validateHoles(polygon: LocalPoint[], holes: LocalPoint[][]): void {
	for (let holeIndex = 0; holeIndex < holes.length; holeIndex++) {
		const hole = holes[holeIndex];
		if (hole.length < 3) {
			throw new Error(`第 ${holeIndex + 1} 个挖孔至少需要 3 个顶点`);
		}
		if (Math.abs(calculateSignedArea(hole)) <= EPSILON) {
			throw new Error(`第 ${holeIndex + 1} 个挖孔面积无效`);
		}
		for (let vertexIndex = 0; vertexIndex < hole.length; vertexIndex++) {
			if (!isPointStrictlyInsideRing(hole[vertexIndex], polygon)) {
				throw new Error(`第 ${holeIndex + 1} 个挖孔超出测区范围，请调整后重新生成航线`);
			}
			for (let otherIndex = 0; otherIndex < holes.length; otherIndex++) {
				if (otherIndex !== holeIndex && isPointInsidePolygon(hole[vertexIndex], holes[otherIndex])) {
					throw new Error('挖孔之间存在重叠，请调整后重新生成航线');
				}
			}
		}
		if (doRingsIntersect(hole, polygon)) {
			throw new Error(`第 ${holeIndex + 1} 个挖孔与测区边界相交，请调整后重新生成航线`);
		}
		for (let otherIndex = 0; otherIndex < holeIndex; otherIndex++) {
			if (doRingsIntersect(hole, holes[otherIndex])) {
				throw new Error('挖孔之间存在重叠，请调整后重新生成航线');
			}
		}
	}
}

/**
 * 判断两个闭合环的边是否存在相交（含端点接触）。
 */
export function doRingsIntersect(ringA: LocalPoint[], ringB: LocalPoint[]): boolean {
	for (let indexA = 0; indexA < ringA.length; indexA++) {
		const nextA = (indexA + 1) % ringA.length;
		for (let indexB = 0; indexB < ringB.length; indexB++) {
			const nextB = (indexB + 1) % ringB.length;
			if (doSegmentsIntersect(ringA[indexA], ringA[nextA], ringB[indexB], ringB[nextB])) {
				return true;
			}
		}
	}
	return false;
}

/**
 * 判断两条线段是否相交（含端点接触与共线重叠）。
 */
function doSegmentsIntersect(startA: LocalPoint, endA: LocalPoint, startB: LocalPoint, endB: LocalPoint): boolean {
	const offsetAB = subtract(startB, startA);
	const directionA = subtract(endA, startA);
	const directionB = subtract(endB, startB);
	const crossAB = cross(directionA, directionB);

	if (Math.abs(crossAB) > EPSILON) {
		const parameterA = cross(offsetAB, directionB) / crossAB;
		const parameterB = cross(offsetAB, directionA) / crossAB;
		return parameterA >= -EPSILON && parameterA <= 1 + EPSILON && parameterB >= -EPSILON && parameterB <= 1 + EPSILON;
	}

	// 平行：先排除不共线情况，再检查投影区间是否重叠
	if (Math.abs(cross(offsetAB, directionA)) > EPSILON) {
		return false;
	}
	const squaredLength = dot(directionA, directionA);
	if (squaredLength <= EPSILON) {
		return true;
	}
	const startParameter = dot(offsetAB, directionA) / squaredLength;
	const endParameter = dot(subtract(endB, startA), directionA) / squaredLength;
	const lower = Math.min(startParameter, endParameter);
	const upper = Math.max(startParameter, endParameter);
	return lower <= 1 + EPSILON && upper >= -EPSILON;
}

/**
 * 判断点是否位于简单多边形内部或边界上。
 */
export function isPointInsidePolygon(point: LocalPoint, polygon: LocalPoint[]): boolean {
	let inside = false;

	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index++) {
		const currentPoint = polygon[index];
		const previousPoint = polygon[previous];
		if (isPointOnSegment(point, previousPoint, currentPoint)) {
			return true;
		}

		const crossesLatitude = currentPoint.y > point.y !== previousPoint.y > point.y;
		if (!crossesLatitude) {
			continue;
		}

		const xAtLatitude = ((previousPoint.x - currentPoint.x) * (point.y - currentPoint.y)) / (previousPoint.y - currentPoint.y) + currentPoint.x;
		if (point.x < xAtLatitude) {
			inside = !inside;
		}
	}

	return inside;
}

/**
 * 校验规划输入，阻止退化多边形进入扫描循环。
 */
function validateOptions(options: PlanarRouteOptions): void {
	if (options.polygon.length < 3) {
		throw new Error('测区至少需要 3 个顶点');
	}
	if (Math.abs(calculateSignedArea(options.polygon)) <= EPSILON) {
		throw new Error('测区面积无效');
	}
	validateHoles(options.polygon, options.holes ?? []);
	if (!Number.isFinite(options.maximumLineSpacing) || options.maximumLineSpacing <= 0) {
		throw new Error('自动行距无效');
	}
	if (!Number.isFinite(options.footprintWidth) || options.footprintWidth <= 0) {
		throw new Error('相机覆盖宽度无效');
	}
}

/**
 * 收集多边形边的无向方位角，作为自动优化候选方向。
 */
function collectCandidateAngles(polygon: LocalPoint[]): number[] {
	const angles: number[] = [];

	for (let index = 0; index < polygon.length; index++) {
		const nextIndex = (index + 1) % polygon.length;
		const deltaX = polygon[nextIndex].x - polygon[index].x;
		const deltaY = polygon[nextIndex].y - polygon[index].y;
		if (Math.hypot(deltaX, deltaY) <= EPSILON) {
			continue;
		}

		const heading = (Math.atan2(deltaX, deltaY) * 180) / Math.PI;
		const angle = normalizeAxisAngle(Math.round(heading));
		let duplicated = false;
		for (let angleIndex = 0; angleIndex < angles.length; angleIndex++) {
			if (axisAngleDifference(angles[angleIndex], angle) < 0.1) {
				duplicated = true;
				break;
			}
		}
		if (!duplicated) {
			angles.push(angle);
		}
	}

	return angles;
}

/**
 * 生成指定方向的扫描行，并比较四种往返起始方式。
 */
function calculatePlanForAngle(options: PlanarRouteOptions, holes: LocalPoint[][], angle: number): PlanarRoutePlan | null {
	const rowsResult = createScanRows(options.polygon, holes, angle, options.maximumLineSpacing);
	if (rowsResult.rows.length === 0) {
		return null;
	}

	let bestPlan: PlanarRoutePlan | null = null;
	const rowDirections = [false, true];
	const initialDirections = [false, true];

	for (let rowIndex = 0; rowIndex < rowDirections.length; rowIndex++) {
		for (let directionIndex = 0; directionIndex < initialDirections.length; directionIndex++) {
			const orderedIntervals = orderScanIntervals(rowsResult.rows, rowDirections[rowIndex], initialDirections[directionIndex]);
			const plan = assembleRoute(options, holes, orderedIntervals, angle, rowsResult.lineSpacing);
			if (!bestPlan || plan.score < bestPlan.score) {
				bestPlan = plan;
			}
		}
	}

	return bestPlan;
}

/**
 * 在旋转坐标系中生成覆盖测区的平行扫描行。
 */
function createScanRows(polygon: LocalPoint[], holes: LocalPoint[][], angle: number, maximumLineSpacing: number): { rows: ScanRow[]; lineSpacing: number } {
	const rotatedPolygon: RotatedPoint[] = [];
	for (let index = 0; index < polygon.length; index++) {
		rotatedPolygon.push(rotatePoint(polygon[index], angle));
	}
	const rotatedHoles: RotatedPoint[][] = holes.map((hole) => {
		const rotatedHole: RotatedPoint[] = [];
		for (let index = 0; index < hole.length; index++) {
			rotatedHole.push(rotatePoint(hole[index], angle));
		}
		return rotatedHole;
	});

	let minimumCross = Number.POSITIVE_INFINITY;
	let maximumCross = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < rotatedPolygon.length; index++) {
		minimumCross = Math.min(minimumCross, rotatedPolygon[index].cross);
		maximumCross = Math.max(maximumCross, rotatedPolygon[index].cross);
	}

	const positionsResult = calculateScanLinePositions(minimumCross, maximumCross, maximumLineSpacing);
	const rows: ScanRow[] = [];
	const rotatedRings = [rotatedPolygon, ...rotatedHoles];

	for (let index = 0; index < positionsResult.positions.length; index++) {
		const cross = positionsResult.positions[index];
		const intervals = clipScanLine(rotatedRings, angle, cross);
		if (intervals.length > 0) {
			rows.push({ cross, intervals });
		}
	}
	assignCaptureGroups(rows);

	return {
		rows,
		lineSpacing: positionsResult.lineSpacing,
	};
}

/**
 * 根据相邻扫描行区间的沿线重叠关系划分独立拍照块。
 */
function assignCaptureGroups(rows: ScanRow[]): void {
	const parents: number[] = [];
	const rowNodeIndexes: number[][] = [];
	const intervals: ScanInterval[] = [];
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const nodeIndexes: number[] = [];
		for (let intervalIndex = 0; intervalIndex < rows[rowIndex].intervals.length; intervalIndex++) {
			const nodeIndex = intervals.length;
			intervals.push(rows[rowIndex].intervals[intervalIndex]);
			parents.push(nodeIndex);
			nodeIndexes.push(nodeIndex);
		}
		rowNodeIndexes.push(nodeIndexes);
	}

	for (let rowIndex = 0; rowIndex + 1 < rows.length; rowIndex++) {
		const currentIndexes = rowNodeIndexes[rowIndex];
		const nextIndexes = rowNodeIndexes[rowIndex + 1];
		for (let currentIndex = 0; currentIndex < currentIndexes.length; currentIndex++) {
			const currentInterval = intervals[currentIndexes[currentIndex]];
			for (let nextIndex = 0; nextIndex < nextIndexes.length; nextIndex++) {
				const nextInterval = intervals[nextIndexes[nextIndex]];
				const overlapStart = Math.max(currentInterval.startAlong, nextInterval.startAlong);
				const overlapEnd = Math.min(currentInterval.endAlong, nextInterval.endAlong);
				if (overlapEnd >= overlapStart - EPSILON) {
					unionCaptureGroups(parents, currentIndexes[currentIndex], nextIndexes[nextIndex]);
				}
			}
		}
	}

	const compactGroupIds = new Map<number, number>();
	for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex++) {
		const root = findCaptureGroupRoot(parents, intervalIndex);
		let groupId = compactGroupIds.get(root);
		if (groupId === undefined) {
			groupId = compactGroupIds.size;
			compactGroupIds.set(root, groupId);
		}
		intervals[intervalIndex].captureGroupId = groupId;
	}
}

/**
 * 查找拍照块并查集根节点并压缩路径。
 */
function findCaptureGroupRoot(parents: number[], index: number): number {
	let root = index;
	while (parents[root] !== root) {
		root = parents[root];
	}
	let current = index;
	while (parents[current] !== current) {
		const next = parents[current];
		parents[current] = root;
		current = next;
	}
	return root;
}

/**
 * 合并两个相邻扫描区间所属的拍照块。
 */
function unionCaptureGroups(parents: number[], left: number, right: number): void {
	const leftRoot = findCaptureGroupRoot(parents, left);
	const rightRoot = findCaptureGroupRoot(parents, right);
	if (leftRoot !== rightRoot) {
		parents[rightRoot] = leftRoot;
	}
}

/**
 * 以测区横向中心为基准，按照相机计算行距向两侧固定间隔展开扫描行。
 */
function calculateScanLinePositions(minimumCross: number, maximumCross: number, lineSpacing: number): { positions: number[]; lineSpacing: number } {
	const center = (minimumCross + maximumCross) / 2;
	const positions: number[] = [center];

	for (let offset = lineSpacing; ; offset += lineSpacing) {
		const lower = center - offset;
		const upper = center + offset;
		let added = false;

		if (lower > minimumCross + EPSILON) {
			positions.push(lower);
			added = true;
		}
		if (upper < maximumCross - EPSILON) {
			positions.push(upper);
			added = true;
		}
		if (!added) {
			break;
		}
	}

	positions.sort((left, right) => left - right);
	return { positions, lineSpacing };
}

/**
 * 将一条无限扫描线裁剪为简单多边形内部的若干区间。
 */
function clipScanLine(rotatedRings: RotatedPoint[][], angle: number, cross: number): ScanInterval[] {
	const intersections: number[] = [];

	for (let ringIndex = 0; ringIndex < rotatedRings.length; ringIndex++) {
		const rotatedPolygon = rotatedRings[ringIndex];
		for (let index = 0; index < rotatedPolygon.length; index++) {
			const nextIndex = (index + 1) % rotatedPolygon.length;
			const start = rotatedPolygon[index];
			const end = rotatedPolygon[nextIndex];
			const crosses = (start.cross <= cross && end.cross > cross) || (end.cross <= cross && start.cross > cross);
			if (!crosses) {
				continue;
			}

			const ratio = (cross - start.cross) / (end.cross - start.cross);
			const along = start.along + (end.along - start.along) * ratio;
			intersections.push(along);
		}
	}

	intersections.sort((left, right) => left - right);
	const uniqueIntersections: number[] = [];
	for (let index = 0; index < intersections.length; index++) {
		const previous = uniqueIntersections[uniqueIntersections.length - 1];
		if (uniqueIntersections.length === 0 || Math.abs(intersections[index] - previous) > EPSILON) {
			uniqueIntersections.push(intersections[index]);
		}
	}

	const intervals: ScanInterval[] = [];
	for (let index = 0; index + 1 < uniqueIntersections.length; index += 2) {
		const startAlong = uniqueIntersections[index];
		const endAlong = uniqueIntersections[index + 1];
		if (endAlong - startAlong <= EPSILON) {
			continue;
		}
		intervals.push({
			start: restorePoint(startAlong, cross, angle),
			end: restorePoint(endAlong, cross, angle),
			startAlong,
			endAlong,
			captureGroupId: -1,
		});
	}

	return intervals;
}

/**
 * 按扫描行顺序和往返方向排列所有拍摄区间。
 */
function orderScanIntervals(rows: ScanRow[], reverseRows: boolean, initialReverse: boolean): ScanInterval[] {
	const orderedRows = [...rows];
	if (reverseRows) {
		orderedRows.reverse();
	}

	const result: ScanInterval[] = [];
	for (let rowIndex = 0; rowIndex < orderedRows.length; rowIndex++) {
		const reverse = rowIndex % 2 === 0 ? initialReverse : !initialReverse;
		const intervals = [...orderedRows[rowIndex].intervals];
		intervals.sort((left, right) => left.startAlong - right.startAlong);
		if (reverse) {
			intervals.reverse();
		}

		for (let intervalIndex = 0; intervalIndex < intervals.length; intervalIndex++) {
			const interval = intervals[intervalIndex];
			if (reverse) {
				result.push({
					start: interval.end,
					end: interval.start,
					startAlong: interval.endAlong,
					endAlong: interval.startAlong,
					captureGroupId: interval.captureGroupId,
				});
			} else {
				result.push(interval);
			}
		}
	}

	return result;
}

/**
 * 使用测区内最短路径连接扫描区间，并计算方向评分。
 */
function assembleRoute(options: PlanarRouteOptions, holes: LocalPoint[][], intervals: ScanInterval[], angle: number, lineSpacing: number): PlanarRoutePlan {
	const segments: PlanarRouteSegment[] = [];
	let scanLength = 0;
	let transitLength = 0;
	let previousEnd: LocalPoint | null = null;
	let previousCaptureGroupId: number | undefined;

	for (let index = 0; index < intervals.length; index++) {
		const interval = intervals[index];
		if (previousEnd) {
			const transitPoints = findShortestPathInsidePolygon(previousEnd, interval.start, options.polygon, holes);
			const length = calculatePolylineLength(transitPoints);
			if (length > EPSILON) {
				const captureGroupId = previousCaptureGroupId === interval.captureGroupId ? interval.captureGroupId : undefined;
				segments.push({ type: 'transit', points: transitPoints, captureGroupId });
				transitLength += length;
			}
		}

		const scanPoints = [interval.start, interval.end];
		segments.push({ type: 'scan', points: scanPoints, captureGroupId: interval.captureGroupId });
		scanLength += distance(interval.start, interval.end);
		previousEnd = interval.end;
		previousCaptureGroupId = interval.captureGroupId;
	}

	const routePoints = flattenRoutePoints(segments);
	const turnCount = countTurns(routePoints);
	const firstPoint = routePoints[0];
	const entryDistance = options.takeoffPoint && firstPoint ? distance(options.takeoffPoint, firstPoint) : 0;
	const totalLength = scanLength + transitLength;
	const turnPenalty = Math.max(lineSpacing, MIN_TURN_PENALTY);
	const score = totalLength + entryDistance + turnCount * turnPenalty;

	return {
		angle,
		lineSpacing,
		scanLength,
		transitLength,
		totalLength,
		turnCount,
		entryDistance,
		score,
		segments,
	};
}

/**
 * 在简单多边形可见图上计算两个点之间的最短内部路径。
 */
function findShortestPathInsidePolygon(start: LocalPoint, end: LocalPoint, polygon: LocalPoint[], holes: LocalPoint[][] = []): LocalPoint[] {
	if (distance(start, end) <= EPSILON) {
		return [start];
	}
	if (isSegmentInsidePolygon(start, end, polygon, holes)) {
		return [start, end];
	}

	const nodes: LocalPoint[] = [start, end];
	for (let index = 0; index < polygon.length; index++) {
		nodes.push(polygon[index]);
	}
	for (let holeIndex = 0; holeIndex < holes.length; holeIndex++) {
		const hole = holes[holeIndex];
		for (let index = 0; index < hole.length; index++) {
			nodes.push(hole[index]);
		}
	}

	const nodeCount = nodes.length;
	const graph: number[][] = [];
	for (let row = 0; row < nodeCount; row++) {
		const graphRow: number[] = [];
		for (let column = 0; column < nodeCount; column++) {
			graphRow.push(Number.POSITIVE_INFINITY);
		}
		graph[row] = graphRow;
	}

	for (let left = 0; left < nodeCount; left++) {
		graph[left][left] = 0;
		for (let right = left + 1; right < nodeCount; right++) {
			if (!isSegmentInsidePolygon(nodes[left], nodes[right], polygon, holes)) {
				continue;
			}
			const length = distance(nodes[left], nodes[right]);
			graph[left][right] = length;
			graph[right][left] = length;
		}
	}

	const previous = runDijkstra(graph, 0);
	if (previous[1] === -1) {
		throw new Error('测区内部航段无法连通');
	}

	const pathIndexes: number[] = [];
	let current = 1;
	while (current !== -1) {
		pathIndexes.push(current);
		if (current === 0) {
			break;
		}
		current = previous[current];
	}
	pathIndexes.reverse();

	const path: LocalPoint[] = [];
	for (let index = 0; index < pathIndexes.length; index++) {
		path.push(nodes[pathIndexes[index]]);
	}
	return path;
}

/**
 * 执行可见图最短路径搜索并返回前驱节点。
 */
function runDijkstra(graph: number[][], source: number): number[] {
	const distances: number[] = [];
	const previous: number[] = [];
	const visited: boolean[] = [];

	for (let index = 0; index < graph.length; index++) {
		distances[index] = Number.POSITIVE_INFINITY;
		previous[index] = -1;
		visited[index] = false;
	}
	distances[source] = 0;

	for (let count = 0; count < graph.length; count++) {
		let current = -1;
		let minimumDistance = Number.POSITIVE_INFINITY;
		for (let index = 0; index < graph.length; index++) {
			if (!visited[index] && distances[index] < minimumDistance) {
				minimumDistance = distances[index];
				current = index;
			}
		}
		if (current === -1) {
			break;
		}

		visited[current] = true;
		for (let neighbor = 0; neighbor < graph.length; neighbor++) {
			const edgeLength = graph[current][neighbor];
			if (!Number.isFinite(edgeLength) || visited[neighbor]) {
				continue;
			}
			const candidateDistance = distances[current] + edgeLength;
			if (candidateDistance < distances[neighbor]) {
				distances[neighbor] = candidateDistance;
				previous[neighbor] = current;
			}
		}
	}

	return previous;
}

/**
 * 通过边界交点分段检查线段是否始终位于多边形内部或边界上。
 */
function isSegmentInsidePolygon(start: LocalPoint, end: LocalPoint, polygon: LocalPoint[], holes: LocalPoint[][] = []): boolean {
	const parameters: number[] = [0, 1];
	const rings = [polygon, ...holes];
	for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
		const ring = rings[ringIndex];
		for (let index = 0; index < ring.length; index++) {
			const nextIndex = (index + 1) % ring.length;
			const edgeParameters = collectIntersectionParameters(start, end, ring[index], ring[nextIndex]);
			for (let parameterIndex = 0; parameterIndex < edgeParameters.length; parameterIndex++) {
				parameters.push(edgeParameters[parameterIndex]);
			}
		}
	}

	parameters.sort((left, right) => left - right);
	const uniqueParameters: number[] = [];
	for (let index = 0; index < parameters.length; index++) {
		const parameter = clamp(parameters[index], 0, 1);
		const previous = uniqueParameters[uniqueParameters.length - 1];
		if (uniqueParameters.length === 0 || Math.abs(parameter - previous) > EPSILON) {
			uniqueParameters.push(parameter);
		}
	}

	for (let index = 0; index + 1 < uniqueParameters.length; index++) {
		const middle = (uniqueParameters[index] + uniqueParameters[index + 1]) / 2;
		const point = interpolate(start, end, middle);
		if (!isPointInsidePolygonWithHoles(point, polygon, holes)) {
			return false;
		}
	}

	return true;
}

/**
 * 收集两条线段在第一条线段上的交点参数，包含共线重叠端点。
 */
function collectIntersectionParameters(start: LocalPoint, end: LocalPoint, edgeStart: LocalPoint, edgeEnd: LocalPoint): number[] {
	const direction = subtract(end, start);
	const edgeDirection = subtract(edgeEnd, edgeStart);
	const offset = subtract(edgeStart, start);
	const denominator = cross(direction, edgeDirection);

	if (Math.abs(denominator) > EPSILON) {
		const parameter = cross(offset, edgeDirection) / denominator;
		const edgeParameter = cross(offset, direction) / denominator;
		if (parameter >= -EPSILON && parameter <= 1 + EPSILON && edgeParameter >= -EPSILON && edgeParameter <= 1 + EPSILON) {
			return [parameter];
		}
		return [];
	}

	if (Math.abs(cross(offset, direction)) > EPSILON) {
		return [];
	}

	const squaredLength = dot(direction, direction);
	if (squaredLength <= EPSILON) {
		return [];
	}
	const startParameter = dot(subtract(edgeStart, start), direction) / squaredLength;
	const endParameter = dot(subtract(edgeEnd, start), direction) / squaredLength;
	return [startParameter, endParameter];
}

/**
 * 将航段合并为连续点列，用于统计转弯。
 */
function flattenRoutePoints(segments: PlanarRouteSegment[]): LocalPoint[] {
	const points: LocalPoint[] = [];
	for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
		const segment = segments[segmentIndex];
		for (let pointIndex = 0; pointIndex < segment.points.length; pointIndex++) {
			const point = segment.points[pointIndex];
			const previous = points[points.length - 1];
			if (!previous || distance(previous, point) > EPSILON) {
				points.push(point);
			}
		}
	}
	return points;
}

/**
 * 统计大于五度的方向变化次数。
 */
function countTurns(points: LocalPoint[]): number {
	let turns = 0;
	const threshold = (5 * Math.PI) / 180;

	for (let index = 1; index + 1 < points.length; index++) {
		const incoming = subtract(points[index], points[index - 1]);
		const outgoing = subtract(points[index + 1], points[index]);
		const incomingLength = Math.hypot(incoming.x, incoming.y);
		const outgoingLength = Math.hypot(outgoing.x, outgoing.y);
		if (incomingLength <= EPSILON || outgoingLength <= EPSILON) {
			continue;
		}
		const cosine = clamp(dot(incoming, outgoing) / (incomingLength * outgoingLength), -1, 1);
		if (Math.acos(cosine) > threshold) {
			turns++;
		}
	}

	return turns;
}

/**
 * 计算折线路径长度。
 */
function calculatePolylineLength(points: LocalPoint[]): number {
	let length = 0;
	for (let index = 0; index + 1 < points.length; index++) {
		length += distance(points[index], points[index + 1]);
	}
	return length;
}

/**
 * 将 ENU 点旋转到扫描线的沿线/横线坐标系。
 */
function rotatePoint(point: LocalPoint, angle: number): RotatedPoint {
	const radians = (angle * Math.PI) / 180;
	const directionX = Math.sin(radians);
	const directionY = Math.cos(radians);
	const crossX = Math.cos(radians);
	const crossY = -Math.sin(radians);
	return {
		along: point.x * directionX + point.y * directionY,
		cross: point.x * crossX + point.y * crossY,
	};
}

/**
 * 将扫描线坐标恢复为 ENU 平面点。
 */
function restorePoint(along: number, crossValue: number, angle: number): LocalPoint {
	const radians = (angle * Math.PI) / 180;
	const directionX = Math.sin(radians);
	const directionY = Math.cos(radians);
	const crossX = Math.cos(radians);
	const crossY = -Math.sin(radians);
	return {
		x: directionX * along + crossX * crossValue,
		y: directionY * along + crossY * crossValue,
	};
}

/**
 * 将方位角归一化为无向扫描轴角度 0~180。
 */
function normalizeAxisAngle(angle: number): number {
	const normalized = ((angle % 180) + 180) % 180;
	return normalized >= 180 - EPSILON ? 0 : normalized;
}

/**
 * 计算两个无向扫描轴之间的最小角差。
 */
function axisAngleDifference(left: number, right: number): number {
	const difference = Math.abs(left - right) % 180;
	return Math.min(difference, 180 - difference);
}

/**
 * 计算简单多边形有符号面积。
 */
function calculateSignedArea(polygon: LocalPoint[]): number {
	let doubledArea = 0;
	for (let index = 0; index < polygon.length; index++) {
		const nextIndex = (index + 1) % polygon.length;
		doubledArea += polygon[index].x * polygon[nextIndex].y - polygon[nextIndex].x * polygon[index].y;
	}
	return doubledArea / 2;
}

/**
 * 判断点是否位于线段上。
 */
function isPointOnSegment(point: LocalPoint, start: LocalPoint, end: LocalPoint): boolean {
	const segment = subtract(end, start);
	const offset = subtract(point, start);
	if (Math.abs(cross(segment, offset)) > EPSILON) {
		return false;
	}
	const projection = dot(offset, segment);
	const squaredLength = dot(segment, segment);
	return projection >= -EPSILON && projection <= squaredLength + EPSILON;
}

/**
 * 线性插值二维点。
 */
function interpolate(start: LocalPoint, end: LocalPoint, parameter: number): LocalPoint {
	return {
		x: start.x + (end.x - start.x) * parameter,
		y: start.y + (end.y - start.y) * parameter,
	};
}

/**
 * 二维向量相减。
 */
function subtract(left: LocalPoint, right: LocalPoint): LocalPoint {
	return { x: left.x - right.x, y: left.y - right.y };
}

/**
 * 二维向量点积。
 */
function dot(left: LocalPoint, right: LocalPoint): number {
	return left.x * right.x + left.y * right.y;
}

/**
 * 二维向量叉积标量。
 */
function cross(left: LocalPoint, right: LocalPoint): number {
	return left.x * right.y - left.y * right.x;
}

/**
 * 计算二维点距离。
 */
function distance(left: LocalPoint, right: LocalPoint): number {
	return Math.hypot(left.x - right.x, left.y - right.y);
}

/**
 * 将数值限制在闭区间内。
 */
function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
