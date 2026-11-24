/**
 * 智能摆拍航线。
 * 每条扫描线先按自己的截面裁到测区边上，再沿航向外扩。
 * 外扩距离来自司空同一组对比：斜视中心点要落到边界上，并再留 40 米转弯引入。
 * 矩形各条截面一样宽，外扩不收回；一头宽一头窄时，窄的一侧外扩更长，宽的一侧只留引入。
 */
import { LocalPoint, PlanarRoutePlan, PlanarRouteSegment, SmartObliquePose } from './wayLineCalc';

const FORWARD_YAW_DEGREES = 45;
const REAR_YAW_DEGREES = 50;
const NADIR_PITCH = -90;
const REAR_PITCH = -120;
const TURN_LEAD_METERS = 40;
const EPSILON = 1e-6;

export interface SmartObliqueRouteOptions {
	polygon: LocalPoint[];
	angle: number;
	lineSpacing: number;
	heightMeters: number;
	swingPitchDegrees: number;
	takeoffPoint?: LocalPoint;
}

interface ProjectedPoint {
	along: number;
	cross: number;
}

interface PolygonEdge {
	along: number;
	cross: number;
	deltaAlong: number;
	deltaCross: number;
}

interface ScanChord {
	cross: number;
	alongMin: number;
	alongMax: number;
	lowEdge: PolygonEdge;
	highEdge: PolygonEdge;
	inside: boolean;
	width: number;
}

/**
 * 用测区、航线角和正射行距生成一条智能摆拍航线。
 */
export function buildSmartObliqueRoute(options: SmartObliqueRouteOptions): PlanarRoutePlan {
	const swing = Math.abs(options.swingPitchDegrees);
	const depression = (swing * Math.PI) / 180;
	const yaw = (FORWARD_YAW_DEGREES * Math.PI) / 180;
	const lookDistance = depression > 0.05 ? options.heightMeters / Math.tan(depression) : 0;
	const crossReach = lookDistance * Math.sin(yaw);
	const projected = ensureCounterClockwise(options.polygon.map((point) => project(point, options.angle)));
	const edges = buildEdges(projected);
	let crossMin = Number.POSITIVE_INFINITY;
	let crossMax = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < projected.length; index++) {
		crossMin = Math.min(crossMin, projected[index].cross);
		crossMax = Math.max(crossMax, projected[index].cross);
	}

	const crosses = scanCrossPositions(crossMin, crossMax, options.lineSpacing, crossReach);
	const insideChords = crosses
		.map((cross) => clipScanChord(edges, cross))
		.filter((chord): chord is ScanChord => chord !== null && chord.inside);
	const insideWidths = insideChords.map((chord) => chord.width);
	const minWidth = insideWidths.length > 0 ? Math.min(...insideWidths) : 0;
	const maxWidth = insideWidths.length > 0 ? Math.max(...insideWidths) : 0;
	const tapered = maxWidth - minWidth > options.lineSpacing * 0.5;
	let wideCross = (crossMin + crossMax) / 2;
	let widest = -1;
	for (let index = 0; index < insideChords.length; index++) {
		if (insideChords[index].width > widest) {
			widest = insideChords[index].width;
			wideCross = insideChords[index].cross;
		}
	}
	const narrowCross = Math.abs(crossMin - wideCross) > Math.abs(crossMax - wideCross) ? crossMin : crossMax;
	const chords: ScanChord[] = [];
	for (let index = 0; index < crosses.length; index++) {
		const cross = crosses[index];
		const inside = insideChords.find((chord) => Math.abs(chord.cross - cross) < 0.01);
		const probe = inside ?? { cross, alongMin: 0, alongMax: 0, lowEdge: edges[0], highEdge: edges[0], inside: false, width: 0 };
		const large = usesLargeMargin(probe, tapered, minWidth, maxWidth, wideCross, narrowCross);
		const chord = offsetScanChord(edges, cross, large, lookDistance);
		if (chord) {
			chords.push(chord);
		}
	}

	const candidates = [
		orderLines(chords, false, false),
		orderLines(chords, false, true),
		orderLines(chords, true, true),
		orderLines(chords, true, false),
	];
	let best = candidates[0];
	let bestEntry = Number.POSITIVE_INFINITY;
	for (let index = 0; index < candidates.length; index++) {
		const entry = firstPointDistance(options, candidates[index]);
		if (entry < bestEntry) {
			best = candidates[index];
			bestEntry = entry;
		}
	}

	const segments: PlanarRouteSegment[] = [];
	let scanLength = 0;
	let transitLength = 0;
	let previousEnd: LocalPoint | null = null;
	for (let index = 0; index < best.length; index++) {
		const line = best[index];
		const lineSegments = createLineSegments({
			angle: options.angle,
			cross: line.chord.cross,
			flyPositive: line.flyPositive,
			alongMin: line.chord.alongMin,
			alongMax: line.chord.alongMax,
			swingPitch: -swing,
			wantPositiveCross: line.wantPositiveCross,
			pattern: line.outerPair ? 'edge' : 'middle',
			captureGroupId: index,
		});
		if (previousEnd && lineSegments.length > 0) {
			const nextStart = lineSegments[0].points[0];
			const transit = distance(previousEnd, nextStart);
			if (transit > EPSILON) {
				segments.push({ type: 'transit', points: [previousEnd, nextStart] });
				transitLength += transit;
			}
		}
		for (let segmentIndex = 0; segmentIndex < lineSegments.length; segmentIndex++) {
			const segment = lineSegments[segmentIndex];
			segments.push(segment);
			scanLength += distance(segment.points[0], segment.points[segment.points.length - 1]);
		}
		if (lineSegments.length > 0) {
			const last = lineSegments[lineSegments.length - 1];
			previousEnd = last.points[last.points.length - 1];
		}
	}

	const totalLength = scanLength + transitLength;
	return {
		angle: options.angle,
		lineSpacing: options.lineSpacing,
		scanLength,
		transitLength,
		totalLength,
		turnCount: Math.max(0, best.length - 1),
		entryDistance: Number.isFinite(bestEntry) ? bestEntry : 0,
		score: totalLength,
		segments,
	};
}

interface OrderedLine {
	chord: ScanChord;
	flyPositive: boolean;
	wantPositiveCross: boolean;
	outerPair: boolean;
}

/**
 * 以测区横向中心为基准排扫描线，并保留斜视能够到的外侧线。
 */
function scanCrossPositions(crossMin: number, crossMax: number, lineSpacing: number, crossReach: number): number[] {
	const center = (crossMin + crossMax) / 2;
	const positions = [center];
	for (let offset = lineSpacing; ; offset += lineSpacing) {
		const lower = center - offset;
		const upper = center + offset;
		let added = false;
		if (crossMin - lower <= crossReach + EPSILON) {
			positions.push(lower);
			added = true;
		}
		if (upper - crossMax <= crossReach + EPSILON) {
			positions.push(upper);
			added = true;
		}
		if (!added) {
			break;
		}
	}
	positions.sort((left, right) => left - right);
	return positions;
}

function orderLines(chords: ScanChord[], reverseRows: boolean, reverseFirst: boolean): OrderedLine[] {
	const indexes = chords.map((_, index) => index);
	if (reverseRows) {
		indexes.reverse();
	}
	const progressingPositive = !reverseRows;
	return indexes.map((sourceIndex, orderIndex) => {
		const flyPositive = orderIndex % 2 === 0 ? !reverseFirst : reverseFirst;
		const firstHalf = orderIndex < indexes.length / 2;
		return {
			chord: chords[sourceIndex],
			flyPositive,
			wantPositiveCross: firstHalf ? progressingPositive : !progressingPositive,
			outerPair: orderIndex < 2 || orderIndex >= indexes.length - 2,
		};
	});
}

function firstPointDistance(options: SmartObliqueRouteOptions, lines: OrderedLine[]): number {
	if (!options.takeoffPoint || lines.length === 0) {
		return 0;
	}
	const line = lines[0];
	const startAlong = line.flyPositive ? line.chord.alongMin : line.chord.alongMax;
	return distance(options.takeoffPoint, restore(startAlong, line.chord.cross, options.angle));
}

/**
 * 截面明显变窄的一侧要自己把边界照到，宽的一侧只留转弯引入。
 * 矩形截面宽度几乎不变，每条都按斜视距离外扩。
 */
function usesLargeMargin(chord: ScanChord, tapered: boolean, minWidth: number, maxWidth: number, wideCross: number, narrowCross: number): boolean {
	if (!tapered) {
		return true;
	}
	if (!chord.inside) {
		return Math.abs(chord.cross - narrowCross) < Math.abs(chord.cross - wideCross);
	}
	return chord.width <= (minWidth + maxWidth) / 2 + EPSILON;
}

/**
 * 把每条边沿外法线推出斜视余量，再和扫描线相交。
 * 这样测区外的航线会顺着两侧边延长，而不是拉成整块外包矩形。
 */
function offsetScanChord(edges: PolygonEdge[], cross: number, large: boolean, lookDistance: number): ScanChord | null {
	const yaw = (FORWARD_YAW_DEGREES * Math.PI) / 180;
	const shifted: PolygonEdge[] = [];
	for (let index = 0; index < edges.length; index++) {
		const edge = edges[index];
		const length = Math.hypot(edge.deltaAlong, edge.deltaCross) || 1;
		const sinPhi = Math.abs(edge.deltaCross) / length;
		const cosPhi = Math.abs(edge.deltaAlong) / length;
		const margin = sinPhi < 0.2
			? (large ? lookDistance * Math.sin(yaw) : TURN_LEAD_METERS)
			: large
				? lookDistance * Math.cos(yaw) * (1 + cosPhi) + TURN_LEAD_METERS * sinPhi
				: TURN_LEAD_METERS;
		shifted.push({
			along: edge.along + (edge.deltaCross / length) * margin,
			cross: edge.cross - (edge.deltaAlong / length) * margin,
			deltaAlong: edge.deltaAlong,
			deltaCross: edge.deltaCross,
		});
	}
	const chord = intersectHalfPlanes(shifted, cross, false);
	if (!chord) {
		return null;
	}
	return { ...chord, cross, inside: true, width: chord.alongMax - chord.alongMin };
}

function buildEdges(polygon: ProjectedPoint[]): PolygonEdge[] {
	const edges: PolygonEdge[] = [];
	for (let index = 0; index < polygon.length; index++) {
		const next = polygon[(index + 1) % polygon.length];
		edges.push({
			along: polygon[index].along,
			cross: polygon[index].cross,
			deltaAlong: next.along - polygon[index].along,
			deltaCross: next.cross - polygon[index].cross,
		});
	}
	return edges;
}

/**
 * 用凸多边形的半平面裁出这条扫描线上的截面。测区外则丢掉封口边，沿两侧边延长。
 */
function clipScanChord(edges: PolygonEdge[], cross: number): ScanChord | null {
	const inside = intersectHalfPlanes(edges, cross, false);
	if (inside) {
		return { ...inside, cross, inside: true, width: inside.alongMax - inside.alongMin };
	}
	const extended = intersectHalfPlanes(edges, cross, true);
	if (!extended) {
		return null;
	}
	return { ...extended, cross, inside: false, width: extended.alongMax - extended.alongMin };
}

function intersectHalfPlanes(
	edges: PolygonEdge[],
	cross: number,
	dropClosingEdges: boolean,
): { alongMin: number; alongMax: number; lowEdge: PolygonEdge; highEdge: PolygonEdge } | null {
	let alongMin = Number.NEGATIVE_INFINITY;
	let alongMax = Number.POSITIVE_INFINITY;
	let lowEdge: PolygonEdge | null = null;
	let highEdge: PolygonEdge | null = null;
	for (let index = 0; index < edges.length; index++) {
		const edge = edges[index];
		if (Math.abs(edge.deltaCross) <= 1e-6) {
			const insideEdge = edge.deltaAlong * (cross - edge.cross) >= -EPSILON;
			if (!insideEdge && !dropClosingEdges) {
				return null;
			}
			continue;
		}
		const limit = (edge.deltaAlong * (cross - edge.cross) + edge.deltaCross * edge.along) / edge.deltaCross;
		if (edge.deltaCross > 0) {
			if (limit < alongMax) {
				alongMax = limit;
				highEdge = edge;
			}
		} else if (limit > alongMin) {
			alongMin = limit;
			lowEdge = edge;
		}
	}
	if (!lowEdge || !highEdge || alongMax - alongMin <= 1) {
		return null;
	}
	return { alongMin, alongMax, lowEdge, highEdge };
}

interface LineSegmentOptions {
	angle: number;
	cross: number;
	flyPositive: boolean;
	alongMin: number;
	alongMax: number;
	swingPitch: number;
	wantPositiveCross: boolean;
	pattern: 'edge' | 'middle';
	captureGroupId: number;
}

function createLineSegments(options: LineSegmentOptions): PlanarRouteSegment[] {
	const startAlong = options.flyPositive ? options.alongMin : options.alongMax;
	const endAlong = options.flyPositive ? options.alongMax : options.alongMin;
	const span = Math.abs(endAlong - startAlong);
	if (span <= EPSILON) {
		return [];
	}
	const lead = Math.min(TURN_LEAD_METERS, Math.max(0, span / 2 - 1));
	const sign = options.flyPositive ? 1 : -1;
	const photoStart = startAlong + sign * lead;
	const photoEnd = endAlong - sign * lead;
	const yawSign = options.flyPositive === options.wantPositiveCross ? 1 : -1;
	const forwardYaw = FORWARD_YAW_DEGREES * yawSign;
	const rearYaw = -REAR_YAW_DEGREES * yawSign;
	const bounds = [startAlong];
	if (lead > 1) {
		bounds.push(photoStart);
	}
	if (options.pattern === 'middle') {
		for (let index = 1; index < 5; index++) {
			bounds.push(photoStart + ((photoEnd - photoStart) * index) / 5);
		}
	}
	if (lead > 1) {
		bounds.push(photoEnd);
	}
	bounds.push(endAlong);

	const uniqueBounds: number[] = [];
	for (let index = 0; index < bounds.length; index++) {
		const previous = uniqueBounds[uniqueBounds.length - 1];
		if (uniqueBounds.length === 0 || Math.abs(bounds[index] - previous) > 0.05) {
			uniqueBounds.push(bounds[index]);
		}
	}

	const segments: PlanarRouteSegment[] = [];
	for (let index = 0; index + 1 < uniqueBounds.length; index++) {
		const from = uniqueBounds[index];
		const to = uniqueBounds[index + 1];
		const midpoint = (from + to) / 2;
		const onPhoto = (midpoint - photoStart) * (photoEnd - midpoint) >= -EPSILON;
		const forward = { pitch: options.swingPitch, yaw: forwardYaw };
		const rear = { pitch: REAR_PITCH, yaw: rearYaw };
		const nadir = { pitch: NADIR_PITCH, yaw: 0 };
		let poses: SmartObliquePose[] | undefined;
		if (onPhoto && options.pattern === 'edge') {
			const throughCenter = (midpoint - options.alongMin) * (options.alongMax - midpoint) > span * span * 0.08;
			poses = throughCenter ? [rear, forward] : midpoint * sign < ((photoStart + photoEnd) / 2) * sign ? [forward] : [rear];
		} else if (onPhoto) {
			const ratio = (midpoint - photoStart) / (photoEnd - photoStart || 1);
			if (ratio < 0.2) {
				poses = [forward];
			} else if (ratio < 0.4) {
				poses = [nadir, forward];
			} else if (ratio < 0.6) {
				poses = [nadir, rear, forward];
			} else if (ratio < 0.8) {
				poses = [nadir, rear];
			} else {
				poses = [rear];
			}
		}
		segments.push({
			type: 'scan',
			points: [restore(from, options.cross, options.angle), restore(to, options.cross, options.angle)],
			smartObliquePoses: poses,
			captureGroupId: onPhoto ? options.captureGroupId : undefined,
		});
	}
	return segments;
}

function ensureCounterClockwise(polygon: ProjectedPoint[]): ProjectedPoint[] {
	let area = 0;
	for (let index = 0; index < polygon.length; index++) {
		const next = polygon[(index + 1) % polygon.length];
		area += polygon[index].along * next.cross - next.along * polygon[index].cross;
	}
	if (area < 0) {
		return [...polygon].reverse();
	}
	return polygon;
}

function project(point: LocalPoint, angle: number): ProjectedPoint {
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

function restore(along: number, crossValue: number, angle: number): LocalPoint {
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

function distance(start: LocalPoint, end: LocalPoint): number {
	return Math.hypot(end.x - start.x, end.y - start.y);
}
