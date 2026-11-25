/**
 * 智能摆拍航线。
 * 凸测区把每条边沿外法线推出后再做半平面裁切。
 * 凹测区不能这么做，所有边一起裁只会留下凸核，航线缩在测区中间。
 * 凹测区按扫描线和边界的真实交点分成若干段，再沿航向外扩。
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
	const chords = isConvexPolygon(edges)
		? buildConvexChords(edges, crosses, options.lineSpacing, lookDistance, crossMin, crossMax)
		: buildConcaveChords(edges, crosses, lookDistance, crossMin, crossMax);

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
	const rows = groupChordsByCross(chords);
	if (reverseRows) {
		rows.reverse();
	}
	const progressingPositive = !reverseRows;
	const lines: OrderedLine[] = [];
	for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
		const flyPositive = rowIndex % 2 === 0 ? !reverseFirst : reverseFirst;
		const firstHalf = rowIndex < rows.length / 2;
		const ordered = flyPositive ? rows[rowIndex] : [...rows[rowIndex]].reverse();
		for (let chordIndex = 0; chordIndex < ordered.length; chordIndex++) {
			lines.push({
				chord: ordered[chordIndex],
				flyPositive,
				wantPositiveCross: firstHalf ? progressingPositive : !progressingPositive,
				outerPair: rowIndex < 2 || rowIndex >= rows.length - 2,
			});
		}
	}
	return lines;
}

function groupChordsByCross(chords: ScanChord[]): ScanChord[][] {
	const rows: ScanChord[][] = [];
	for (let index = 0; index < chords.length; index++) {
		const chord = chords[index];
		const last = rows[rows.length - 1];
		if (last && Math.abs(last[0].cross - chord.cross) < 0.01) {
			last.push(chord);
		} else {
			rows.push([chord]);
		}
	}
	for (let index = 0; index < rows.length; index++) {
		rows[index].sort((left, right) => left.alongMin - right.alongMin);
	}
	return rows;
}

function firstPointDistance(options: SmartObliqueRouteOptions, lines: OrderedLine[]): number {
	if (!options.takeoffPoint || lines.length === 0) {
		return 0;
	}
	const line = lines[0];
	const startAlong = line.flyPositive ? line.chord.alongMin : line.chord.alongMax;
	return distance(options.takeoffPoint, restore(startAlong, line.chord.cross, options.angle));
}

function isConvexPolygon(edges: PolygonEdge[]): boolean {
	for (let index = 0; index < edges.length; index++) {
		const next = edges[(index + 1) % edges.length];
		const turn = edges[index].deltaAlong * next.deltaCross - edges[index].deltaCross * next.deltaAlong;
		if (turn < -1e-2) {
			return false;
		}
	}
	return true;
}

/**
 * 凸测区沿用半平面外扩。矩形和一头窄一头宽的三角形都是在这条路径上对过司空的。
 */
function buildConvexChords(
	edges: PolygonEdge[],
	crosses: number[],
	lineSpacing: number,
	lookDistance: number,
	crossMin: number,
	crossMax: number,
): ScanChord[] {
	const insideChords = crosses
		.map((cross) => clipScanChord(edges, cross))
		.filter((chord): chord is ScanChord => chord !== null && chord.inside);
	const insideWidths = insideChords.map((chord) => chord.width);
	const minWidth = insideWidths.length > 0 ? Math.min(...insideWidths) : 0;
	const maxWidth = insideWidths.length > 0 ? Math.max(...insideWidths) : 0;
	const tapered = maxWidth - minWidth > lineSpacing * 0.5;
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
	return chords;
}

/**
 * 凹测区一条扫描线可能进出多次。只保留真正落在测区里的各段，再按端点所在的边外扩。
 * 测区外侧、斜视还能照到的扫描线，用外扩后的边界补上。
 */
function buildConcaveChords(
	edges: PolygonEdge[],
	crosses: number[],
	lookDistance: number,
	crossMin: number,
	crossMax: number,
): ScanChord[] {
	const insideRows = crosses.map((cross) => clipScanChords(edges, cross));
	let alongMin = Number.POSITIVE_INFINITY;
	let alongMax = Number.NEGATIVE_INFINITY;
	for (let index = 0; index < edges.length; index++) {
		alongMin = Math.min(alongMin, edges[index].along, edges[index].along + edges[index].deltaAlong);
		alongMax = Math.max(alongMax, edges[index].along, edges[index].along + edges[index].deltaAlong);
	}
	const chordLimit = alongMax - alongMin + 20 * lookDistance + 4 * TURN_LEAD_METERS;
	const offsetEdges = buildOffsetEdges(edges, true, lookDistance);
	const chords: ScanChord[] = [];
	for (let index = 0; index < crosses.length; index++) {
		const cross = crosses[index];
		const inside = insideRows[index];
		if (inside.length > 0) {
			const expanded = clipScanChords(offsetEdges, cross);
			for (let chordIndex = 0; chordIndex < inside.length; chordIndex++) {
				chords.push(fitChordToOffset(inside, chordIndex, expanded, lookDistance));
			}
			continue;
		}
		// 凹口内部没有交点，不能补一条横跨缺口的航线。只有测区外侧的斜视航线才外扩。
		if (cross >= crossMin - 0.01 && cross <= crossMax + 0.01) {
			continue;
		}
		const outside = clipScanChords(offsetEdges, cross);
		for (let chordIndex = 0; chordIndex < outside.length; chordIndex++) {
			const chord = outside[chordIndex];
			if (chord.alongMax - chord.alongMin > chordLimit) {
				continue;
			}
			chords.push({ ...chord, cross, inside: false });
		}
	}
	return chords;
}

function fitChordToOffset(inside: ScanChord[], chordIndex: number, expanded: ScanChord[], lookDistance: number): ScanChord {
	const chord = inside[chordIndex];
	const midpoint = (chord.alongMin + chord.alongMax) / 2;
	const previous = inside[chordIndex - 1];
	const next = inside[chordIndex + 1];
	const gapMin = previous ? (previous.alongMax + chord.alongMin) / 2 : Number.NEGATIVE_INFINITY;
	const gapMax = next ? (chord.alongMax + next.alongMin) / 2 : Number.POSITIVE_INFINITY;
	const container = expanded.find((item) => item.alongMin - 1 <= midpoint && midpoint <= item.alongMax + 1);
	const fallback = extendChord(chord, true, lookDistance);
	const rawMin = container ? Math.min(container.alongMin, chord.alongMin) : fallback.alongMin;
	const rawMax = container ? Math.max(container.alongMax, chord.alongMax) : fallback.alongMax;
	// 和航向太平的边会把交点沿航向推出很远，外扩限制在大约两个斜视距离内。
	const cap = lookDistance * 2 + TURN_LEAD_METERS;
	return {
		...chord,
		alongMin: Math.max(rawMin, gapMin, chord.alongMin - cap),
		alongMax: Math.min(rawMax, gapMax, chord.alongMax + cap),
	};
}

function extendChord(chord: ScanChord, large: boolean, lookDistance: number): ScanChord {
	return {
		...chord,
		alongMin: chord.alongMin - alongExtension(chord.lowEdge, large, lookDistance),
		alongMax: chord.alongMax + alongExtension(chord.highEdge, large, lookDistance),
	};
}

function alongExtension(edge: PolygonEdge, large: boolean, lookDistance: number): number {
	const length = Math.hypot(edge.deltaAlong, edge.deltaCross) || 1;
	const sinPhi = Math.abs(edge.deltaCross) / length;
	// 和航向几乎平行的边只约束左右范围，不能拿它把航线沿航向拉出几百米。
	if (sinPhi < 0.2) {
		return TURN_LEAD_METERS;
	}
	return perpendicularMargin(edge, large, lookDistance) / sinPhi;
}

function perpendicularMargin(edge: PolygonEdge, large: boolean, lookDistance: number): number {
	const length = Math.hypot(edge.deltaAlong, edge.deltaCross) || 1;
	const sinPhi = Math.abs(edge.deltaCross) / length;
	const cosPhi = Math.abs(edge.deltaAlong) / length;
	const yaw = (FORWARD_YAW_DEGREES * Math.PI) / 180;
	if (sinPhi < 0.2) {
		return large ? lookDistance * Math.sin(yaw) : TURN_LEAD_METERS;
	}
	return large ? lookDistance * Math.cos(yaw) * (1 + cosPhi) + TURN_LEAD_METERS * sinPhi : TURN_LEAD_METERS;
}

/**
 * 扫描线和多边形各边的交点，按沿线位置配成测区内部的若干段。
 */
function clipScanChords(edges: PolygonEdge[], cross: number): ScanChord[] {
	const hits: { along: number; edge: PolygonEdge }[] = [];
	for (let index = 0; index < edges.length; index++) {
		const edge = edges[index];
		const endCross = edge.cross + edge.deltaCross;
		const crosses = (edge.cross <= cross && endCross > cross) || (endCross <= cross && edge.cross > cross);
		if (!crosses || Math.abs(edge.deltaCross) <= 1e-8) {
			continue;
		}
		const ratio = (cross - edge.cross) / edge.deltaCross;
		hits.push({ along: edge.along + edge.deltaAlong * ratio, edge });
	}
	hits.sort((left, right) => left.along - right.along);
	const chords: ScanChord[] = [];
	for (let index = 0; index + 1 < hits.length; index += 2) {
		const alongMin = hits[index].along;
		const alongMax = hits[index + 1].along;
		if (alongMax - alongMin <= 1) {
			continue;
		}
		chords.push({
			cross,
			alongMin,
			alongMax,
			lowEdge: hits[index].edge,
			highEdge: hits[index + 1].edge,
			inside: true,
			width: alongMax - alongMin,
		});
	}
	return chords;
}

function buildOffsetEdges(edges: PolygonEdge[], large: boolean, lookDistance: number): PolygonEdge[] {
	const shifted = edges.map((edge) => shiftEdge(edge, perpendicularMargin(edge, large, lookDistance)));
	const points: ProjectedPoint[] = [];
	for (let index = 0; index < edges.length; index++) {
		const previousIndex = (index - 1 + edges.length) % edges.length;
		const turn = edges[previousIndex].deltaAlong * edges[index].deltaCross - edges[previousIndex].deltaCross * edges[index].deltaAlong;
		if (turn >= -1e-2) {
			const hit = intersectLines(shifted[previousIndex], shifted[index]);
			if (hit) {
				points.push(hit);
				continue;
			}
		}
		const previous = shifted[previousIndex];
		points.push({ along: previous.along + previous.deltaAlong, cross: previous.cross + previous.deltaCross });
		points.push({ along: shifted[index].along, cross: shifted[index].cross });
	}
	return buildEdges(dedupeProjectedPoints(points));
}

function shiftEdge(edge: PolygonEdge, margin: number): PolygonEdge {
	const length = Math.hypot(edge.deltaAlong, edge.deltaCross) || 1;
	return {
		along: edge.along + (edge.deltaCross / length) * margin,
		cross: edge.cross - (edge.deltaAlong / length) * margin,
		deltaAlong: edge.deltaAlong,
		deltaCross: edge.deltaCross,
	};
}

function intersectLines(first: PolygonEdge, second: PolygonEdge): ProjectedPoint | null {
	const determinant = first.deltaAlong * second.deltaCross - first.deltaCross * second.deltaAlong;
	if (Math.abs(determinant) < 1e-8) {
		return null;
	}
	const deltaAlong = second.along - first.along;
	const deltaCross = second.cross - first.cross;
	const scale = (deltaAlong * second.deltaCross - deltaCross * second.deltaAlong) / determinant;
	return {
		along: first.along + scale * first.deltaAlong,
		cross: first.cross + scale * first.deltaCross,
	};
}

function dedupeProjectedPoints(points: ProjectedPoint[]): ProjectedPoint[] {
	const result: ProjectedPoint[] = [];
	for (let index = 0; index < points.length; index++) {
		const point = points[index];
		const previous = result[result.length - 1];
		if (!previous || Math.hypot(point.along - previous.along, point.cross - previous.cross) > 0.05) {
			result.push(point);
		}
	}
	if (result.length > 1) {
		const first = result[0];
		const last = result[result.length - 1];
		if (Math.hypot(first.along - last.along, first.cross - last.cross) <= 0.05) {
			result.pop();
		}
	}
	return result;
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
