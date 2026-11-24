/**
 * 功能名称：面状航线前端 KMZ 导出
 * 日    期：2026/07/17
 */
import * as Cesium from 'cesium';
import JSZip from 'jszip';
import { MINIMUM_PHOTO_INTERVAL_SECONDS } from '../config/planarConfig';
import { CartesianRouteSegment } from './planarTerrain';
import { SmartObliquePose } from './wayLineCalc';

const KML_NAMESPACE = 'http://www.opengis.net/kml/2.2';
const WPML_NAMESPACE = 'http://www.dji.com/wpmz/1.0.6';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const PAYLOAD_POSITION_INDEX = 0;
const DEFAULT_TAKEOFF_SECURITY_HEIGHT = 20;
const DEFAULT_RTH_HEIGHT = 100;

export interface PlanarKmzRoute {
	id: number;
	headingDegrees?: number;
	gimbalPitchDegrees: number;
	segments: CartesianRouteSegment[];
}

export interface PlanarKmzExportOptions {
	isOblique: boolean;
	smartOblique: boolean;
	polygonPositions: Cesium.Cartesian3[];
	takeoffPosition: Cesium.Cartesian3;
	routes: PlanarKmzRoute[];
	lineAngle: number;
	lineHeight: number;
	heightType: number;
	flightSpeed: number;
	transitionalSpeed: number;
	overlapW: number;
	overlapH: number;
	gimbalPitchDegrees: number;
	photoTriggerMode: 'time' | 'distance';
	photoDistance: number;
	droneEnumValue: number;
	droneSubEnumValue: number;
	payloadEnumValue: number;
}

interface ExportWaypoint {
	longitude: number;
	latitude: number;
	height: number;
	gimbalPitchDegrees?: number;
}

interface SmartObliqueRange {
	startIndex: number;
	endIndex: number;
	poses: SmartObliquePose[];
}

interface CaptureRange {
	id: number;
	startIndex: number;
	endIndex: number;
}

interface ExportRouteData {
	id: number;
	headingDegrees?: number;
	gimbalPitchDegrees: number;
	waypoints: ExportWaypoint[];
	captureRanges: CaptureRange[];
	smartObliqueRanges: SmartObliqueRange[];
	distance: number;
}

/**
 * 使用当前前端规划结果生成 DJI WPMZ 格式的 KMZ 文件。
 */
export async function buildPlanarKmz(options: PlanarKmzExportOptions): Promise<Blob> {
	validateExportOptions(options);
	const routeData: ExportRouteData[] = [];
	for (let routeIndex = 0; routeIndex < options.routes.length; routeIndex++) {
		routeData.push(createExportRouteData(options.routes[routeIndex], options));
	}

	const zip = new JSZip();
	const folder = zip.folder('wpmz');
	if (!folder) {
		throw new Error('无法创建 KMZ 目录');
	}
	folder.file('template.kml', buildTemplateKml(options));
	folder.file('waylines.wpml', buildWaylinesWpml(options, routeData));
	return await zip.generateAsync({
		type: 'blob',
		mimeType: 'application/vnd.google-earth.kmz',
		compression: 'DEFLATE',
		compressionOptions: { level: 6 },
	});
}

/**
 * 校验导出所需的测区、航线和飞行参数。
 */
function validateExportOptions(options: PlanarKmzExportOptions): void {
	if (options.polygonPositions.length < 3) {
		throw new Error('请先绘制有效测区');
	}
	const fiveDirection = options.isOblique && !options.smartOblique;
	const expectedRouteCount = fiveDirection ? 5 : 1;
	if (options.routes.length !== expectedRouteCount) {
		throw new Error(fiveDirection ? '倾斜摄影必须包含五组航线' : '正射或智能摆拍必须包含一组航线');
	}
	if (!Number.isFinite(options.flightSpeed) || options.flightSpeed <= 0) {
		throw new Error('航线速度无效');
	}
	if (!Number.isFinite(options.photoDistance) || options.photoDistance <= 0) {
		throw new Error('拍照间隔无效');
	}
	if (![1, 2, 3].includes(options.heightType)) {
		throw new Error('航线高度模式无效');
	}
	for (let routeIndex = 0; routeIndex < options.routes.length; routeIndex++) {
		if (options.routes[routeIndex].segments.length === 0) {
			throw new Error(`第 ${routeIndex + 1} 组航线没有有效航点`);
		}
	}
}

/**
 * 将一组 Cesium 航段转换为去重航点、拍摄区间和航线长度。
 */
function createExportRouteData(route: PlanarKmzRoute, options: PlanarKmzExportOptions): ExportRouteData {
	const waypoints: ExportWaypoint[] = [];
	const captureRangeMap = new Map<number, CaptureRange>();
	const smartObliqueRanges: SmartObliqueRange[] = [];
	let previousPosition: Cesium.Cartesian3 | null = null;
	let distance = 0;

	for (let segmentIndex = 0; segmentIndex < route.segments.length; segmentIndex++) {
		const segment = route.segments[segmentIndex];
		let segmentStartIndex = -1;
		let segmentEndIndex = -1;
		for (let pointIndex = 0; pointIndex < segment.positions.length; pointIndex++) {
			const position = segment.positions[pointIndex];
			if (previousPosition) {
				distance += Cesium.Cartesian3.distance(previousPosition, position);
			}
			if (!previousPosition || Cesium.Cartesian3.distanceSquared(previousPosition, position) > Cesium.Math.EPSILON7) {
				const waypoint = toRouteExportWaypoint(position, options);
				if (segment.smartObliquePoses && segment.smartObliquePoses.length > 0) {
					waypoint.gimbalPitchDegrees = segment.smartObliquePoses[0].pitch;
				}
				waypoints.push(waypoint);
				previousPosition = position;
			}
			const waypointIndex = waypoints.length - 1;
			if (segmentStartIndex === -1) {
				segmentStartIndex = waypointIndex;
			}
			segmentEndIndex = waypointIndex;
		}

		if (segment.smartObliquePoses && segment.smartObliquePoses.length > 0 && segmentStartIndex >= 0 && segmentEndIndex > segmentStartIndex) {
			smartObliqueRanges.push({ startIndex: segmentStartIndex, endIndex: segmentEndIndex, poses: segment.smartObliquePoses });
		}
		if (segment.captureGroupId !== undefined && segmentStartIndex >= 0 && segmentEndIndex >= segmentStartIndex) {
			const currentRange = captureRangeMap.get(segment.captureGroupId);
			if (currentRange) {
				currentRange.startIndex = Math.min(currentRange.startIndex, segmentStartIndex);
				currentRange.endIndex = Math.max(currentRange.endIndex, segmentEndIndex);
			} else {
				captureRangeMap.set(segment.captureGroupId, {
					id: segment.captureGroupId,
					startIndex: segmentStartIndex,
					endIndex: segmentEndIndex,
				});
			}
		}
	}

	if (waypoints.length < 2) {
		throw new Error(`第 ${route.id} 组航线至少需要两个航点`);
	}
	const captureRanges = Array.from(captureRangeMap.values());
	captureRanges.sort((left, right) => left.startIndex - right.startIndex);
	if (captureRanges.length === 0) {
		throw new Error(`第 ${route.id} 组航线没有有效拍摄区段`);
	}
	return {
		id: route.id,
		headingDegrees: route.headingDegrees,
		gimbalPitchDegrees: route.gimbalPitchDegrees,
		waypoints,
		captureRanges,
		smartObliqueRanges,
		distance,
	};
}

/**
 * 将 Cesium 世界坐标转换为 WPML 使用的经纬度和椭球高度。
 */
function toExportWaypoint(position: Cesium.Cartesian3): ExportWaypoint {
	const cartographic = Cesium.Cartographic.fromCartesian(position);
	if (!cartographic) {
		throw new Error('航点坐标转换失败');
	}
	return {
		longitude: Cesium.Math.toDegrees(cartographic.longitude),
		latitude: Cesium.Math.toDegrees(cartographic.latitude),
		height: cartographic.height,
	};
}

/**
 * 将执行航点转换为符合当前执行高度模式的 WPML 高度。
 */
function toRouteExportWaypoint(position: Cesium.Cartesian3, options: PlanarKmzExportOptions): ExportWaypoint {
	const waypoint = toExportWaypoint(position);
	if (options.heightType === 2) {
		// 页面中的相对起飞点高度就是任务高度参数，不能用可能受地形采样误差影响的椭球高差反推。
		return { ...waypoint, height: options.lineHeight };
	}
	// M3TD 不支持 realTimeFollowSurface；仿地航点已完成地形采样，按逐点 WGS84 椭球高执行。
	return waypoint;
}

/**
 * 去除测区连续重复点和重复闭环点，并统一为司空样例使用的顺时针顺序。
 */
function getNormalizedPolygonPositions(positions: Cesium.Cartesian3[]): ExportWaypoint[] {
	const polygon: ExportWaypoint[] = [];
	for (let positionIndex = 0; positionIndex < positions.length; positionIndex++) {
		const point = toExportWaypoint(positions[positionIndex]);
		if (point.longitude < -180 || point.longitude > 180 || point.latitude < -90 || point.latitude > 90) {
			throw new Error('测区包含无效经纬度');
		}
		const previous = polygon[polygon.length - 1];
		if (!previous || !areSameCoordinates(previous, point)) {
			polygon.push(point);
		}
	}
	if (polygon.length > 1 && areSameCoordinates(polygon[0], polygon[polygon.length - 1])) {
		polygon.pop();
	}
	if (polygon.length < 3) {
		throw new Error('测区至少需要三个不同顶点');
	}
	if (calculatePolygonSignedArea(polygon) > 0) {
		polygon.reverse();
	}
	return polygon;
}

/**
 * 判断两个经纬度点是否可视为同一个测区顶点。
 */
function areSameCoordinates(left: ExportWaypoint, right: ExportWaypoint): boolean {
	return Math.abs(left.longitude - right.longitude) <= Cesium.Math.EPSILON10 && Math.abs(left.latitude - right.latitude) <= Cesium.Math.EPSILON10;
}

/**
 * 计算经纬度平面上的测区有符号面积，用于统一顶点绕序。
 */
function calculatePolygonSignedArea(polygon: ExportWaypoint[]): number {
	let doubledArea = 0;
	for (let pointIndex = 0; pointIndex < polygon.length; pointIndex++) {
		const nextIndex = (pointIndex + 1) % polygon.length;
		doubledArea += polygon[pointIndex].longitude * polygon[nextIndex].latitude - polygon[nextIndex].longitude * polygon[pointIndex].latitude;
	}
	return doubledArea / 2;
}

/**
 * 生成描述测区和建图参数的 template.kml。
 */
function buildTemplateKml(options: PlanarKmzExportOptions): string {
	const xmlDocument = createKmlDocument();
	const root = xmlDocument.documentElement;
	const documentElement = appendKmlElement(root, 'Document');
	const timestamp = Date.now();
	appendWpmlElement(documentElement, 'author', 'dcp-webviewer');
	appendWpmlElement(documentElement, 'createTime', timestamp);
	appendWpmlElement(documentElement, 'updateTime', timestamp);
	appendMissionConfig(documentElement, options);

	const folder = appendKmlElement(documentElement, 'Folder');
	appendWpmlElement(folder, 'templateType', options.isOblique && !options.smartOblique ? 'mapping3d' : 'mapping2d');
	appendWpmlElement(folder, 'templateId', 0);
	const coordinateParam = appendWpmlElement(folder, 'waylineCoordinateSysParam');
	appendWpmlElement(coordinateParam, 'coordinateMode', 'WGS84');
	appendWpmlElement(coordinateParam, 'heightMode', getTemplateHeightMode(options.heightType));
	appendWpmlElement(coordinateParam, 'globalShootHeight', options.lineHeight);
	// 相对起飞点/海拔模式不要写仿地字段，否则司空会按仿地路径解析并显示相对地形 0m。
	if (options.heightType === 3) {
		appendWpmlElement(coordinateParam, 'surfaceFollowModeEnable', 1);
		appendWpmlElement(coordinateParam, 'isRealtimeSurfaceFollow', 0);
		appendWpmlElement(coordinateParam, 'surfaceRelativeHeight', options.lineHeight);
	}
	appendWpmlElement(folder, 'autoFlightSpeed', options.flightSpeed);

	const placemark = appendKmlElement(folder, 'Placemark');
	appendWpmlElement(placemark, 'caliFlightEnable', 0);
	if (options.isOblique && !options.smartOblique) {
		appendWpmlElement(placemark, 'inclinedGimbalPitch', options.gimbalPitchDegrees);
	}
	if (options.smartOblique) {
		appendWpmlElement(placemark, 'smartObliqueEnable', 1);
		appendWpmlElement(placemark, 'smartObliqueGimbalPitch', options.gimbalPitchDegrees);
	}
	appendWpmlElement(placemark, 'shootType', options.photoTriggerMode);
	appendWpmlElement(placemark, 'direction', normalizeDirection(options.lineAngle));
	appendWpmlElement(placemark, 'margin', 0);
	appendWpmlElement(placemark, 'inclinedFlightSpeed', options.flightSpeed);
	appendWpmlElement(placemark, 'efficiencyFlightModeEnable', 0);
	appendOverlap(placemark, options);
	appendPolygon(placemark, options.polygonPositions);
	appendWpmlElement(placemark, 'ellipsoidHeight', options.lineHeight);
	appendWpmlElement(placemark, 'height', options.lineHeight);
	appendPayloadParam(folder);
	return serializeXml(xmlDocument);
}

/**
 * 生成包含实际一组或五组执行航点的 waylines.wpml。
 */
function buildWaylinesWpml(options: PlanarKmzExportOptions, routes: ExportRouteData[]): string {
	const xmlDocument = createKmlDocument();
	const root = xmlDocument.documentElement;
	const documentElement = appendKmlElement(root, 'Document');
	appendMissionConfig(documentElement, options);
	for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
		appendWaylineFolder(documentElement, routes[routeIndex], routeIndex, options);
	}
	return serializeXml(xmlDocument);
}

/**
 * 创建带 KML 和 WPML 命名空间的 XML 文档。
 */
function createKmlDocument(): XMLDocument {
	const xmlDocument = document.implementation.createDocument(KML_NAMESPACE, 'kml');
	xmlDocument.documentElement.setAttributeNS(XMLNS_NAMESPACE, 'xmlns:wpml', WPML_NAMESPACE);
	return xmlDocument;
}

/**
 * 写入 template.kml 和 waylines.wpml 共用的任务配置。
 */
function appendMissionConfig(parent: Element, options: PlanarKmzExportOptions): void {
	const missionConfig = appendWpmlElement(parent, 'missionConfig');
	appendWpmlElement(missionConfig, 'flyToWaylineMode', 'safely');
	appendWpmlElement(missionConfig, 'finishAction', 'goHome');
	appendWpmlElement(missionConfig, 'exitOnRCLost', 'goContinue');
	appendWpmlElement(missionConfig, 'executeRCLostAction', 'goBack');
	appendWpmlElement(missionConfig, 'takeOffSecurityHeight', DEFAULT_TAKEOFF_SECURITY_HEIGHT);
	const takeoff = toExportWaypoint(options.takeoffPosition);
	appendWpmlElement(missionConfig, 'takeOffRefPoint', `${formatNumber(takeoff.latitude)},${formatNumber(takeoff.longitude)},${formatNumber(takeoff.height)}`);
	// 参考起飞点离地高（AGL）；贴地起飞为 0，不能填椭球高。
	appendWpmlElement(missionConfig, 'takeOffRefPointAGLHeight', 0);
	appendWpmlElement(missionConfig, 'globalTransitionalSpeed', options.transitionalSpeed);
	appendWpmlElement(missionConfig, 'globalRTHHeight', DEFAULT_RTH_HEIGHT);
	const droneInfo = appendWpmlElement(missionConfig, 'droneInfo');
	appendWpmlElement(droneInfo, 'droneEnumValue', options.droneEnumValue);
	appendWpmlElement(droneInfo, 'droneSubEnumValue', options.droneSubEnumValue);
	appendWpmlElement(missionConfig, 'waylineAvoidLimitAreaMode', 0);
	const payloadInfo = appendWpmlElement(missionConfig, 'payloadInfo');
	appendWpmlElement(payloadInfo, 'payloadEnumValue', options.payloadEnumValue);
	appendWpmlElement(payloadInfo, 'payloadSubEnumValue', 0);
	appendWpmlElement(payloadInfo, 'payloadPositionIndex', PAYLOAD_POSITION_INDEX);
}

/**
 * 写入正射和倾斜摄影共用的重叠率参数。
 */
function appendOverlap(parent: Element, options: PlanarKmzExportOptions): void {
	const overlap = appendWpmlElement(parent, 'overlap');
	appendWpmlElement(overlap, 'orthoCameraOverlapH', options.overlapH);
	appendWpmlElement(overlap, 'orthoCameraOverlapW', options.overlapW);
	appendWpmlElement(overlap, 'inclinedCameraOverlapH', options.overlapH);
	appendWpmlElement(overlap, 'inclinedCameraOverlapW', options.overlapW);
}

/**
 * 写入 template.kml 的测区多边形坐标。
 */
function appendPolygon(parent: Element, positions: Cesium.Cartesian3[]): void {
	const polygon = appendKmlElement(parent, 'Polygon');
	const boundary = appendKmlElement(polygon, 'outerBoundaryIs');
	const ring = appendKmlElement(boundary, 'LinearRing');
	const polygonPositions = getNormalizedPolygonPositions(positions);
	const coordinateLines: string[] = [];
	for (let positionIndex = 0; positionIndex < polygonPositions.length; positionIndex++) {
		const point = polygonPositions[positionIndex];
		coordinateLines.push(`${formatNumber(point.longitude)},${formatNumber(point.latitude)},0`);
	}
	appendKmlElement(ring, 'coordinates', coordinateLines.join(' '));
}

/**
 * 写入相机负载参数。
 */
function appendPayloadParam(parent: Element): void {
	const payloadParam = appendWpmlElement(parent, 'payloadParam');
	appendWpmlElement(payloadParam, 'payloadPositionIndex', PAYLOAD_POSITION_INDEX);
	appendWpmlElement(payloadParam, 'focusMode', 'firstPoint');
	appendWpmlElement(payloadParam, 'meteringMode', 'average');
	appendWpmlElement(payloadParam, 'returnMode', 'singleReturnStrongest');
	appendWpmlElement(payloadParam, 'samplingRate', 240000);
	appendWpmlElement(payloadParam, 'scanningMode', 'repetitive');
	appendWpmlElement(payloadParam, 'imageFormat', 'visable');
	appendWpmlElement(payloadParam, 'photoSize', 'default_l');
}

/**
 * 写入一组可独立执行的 WPML 航线。
 */
function appendWaylineFolder(parent: Element, route: ExportRouteData, routeIndex: number, options: PlanarKmzExportOptions): void {
	const folder = appendKmlElement(parent, 'Folder');
	appendWpmlElement(folder, 'templateId', routeIndex);
	appendWpmlElement(folder, 'executeHeightMode', getExecuteHeightMode(options.heightType));
	appendWpmlElement(folder, 'waylineId', routeIndex);
	appendWpmlElement(folder, 'distance', route.distance);
	appendWpmlElement(folder, 'duration', route.distance / options.flightSpeed);
	appendWpmlElement(folder, 'autoFlightSpeed', options.flightSpeed);
	appendStartActionGroup(folder, route.gimbalPitchDegrees);
	appendWpmlElement(folder, 'realTimeFollowSurfaceByFov', 0);
	for (let waypointIndex = 0; waypointIndex < route.waypoints.length; waypointIndex++) {
		appendPlacemark(folder, route, waypointIndex, options);
	}
}

/**
 * 写入起飞后、进入航线前的云台角度动作。
 */
function appendStartActionGroup(parent: Element, gimbalPitchDegrees: number): void {
	const startActionGroup = appendWpmlElement(parent, 'startActionGroup');
	const action = appendWpmlElement(startActionGroup, 'action');
	appendWpmlElement(action, 'actionId', 0);
	appendWpmlElement(action, 'actionActuatorFunc', 'gimbalRotate');
	appendGimbalRotateParam(action, gimbalPitchDegrees);
	const hoverAction = appendWpmlElement(startActionGroup, 'action');
	appendWpmlElement(hoverAction, 'actionId', 1);
	appendWpmlElement(hoverAction, 'actionActuatorFunc', 'hover');
	const hoverParam = appendWpmlElement(hoverAction, 'actionActuatorFuncParam');
	appendWpmlElement(hoverParam, 'hoverTime', 0.5);
}

/**
 * 写入单个航点及其航向、转弯、云台和拍照动作。
 */
function appendPlacemark(parent: Element, route: ExportRouteData, waypointIndex: number, options: PlanarKmzExportOptions): void {
	const waypoint = route.waypoints[waypointIndex];
	const placemark = appendKmlElement(parent, 'Placemark');
	const point = appendKmlElement(placemark, 'Point');
	appendKmlElement(point, 'coordinates', `${formatNumber(waypoint.longitude)},${formatNumber(waypoint.latitude)}`);
	appendWpmlElement(placemark, 'index', waypointIndex);
	appendWpmlElement(placemark, 'executeHeight', waypoint.height);
	appendWpmlElement(placemark, 'waypointSpeed', options.flightSpeed);
	appendWaypointHeading(placemark, route, waypointIndex);
	appendWaypointTurn(placemark, waypointIndex, route.waypoints.length);
	if (waypointIndex === 0) {
		appendGimbalLockGroup(placemark, route);
	}
	for (let rangeIndex = 0; rangeIndex < route.captureRanges.length; rangeIndex++) {
		const range = route.captureRanges[rangeIndex];
		if (range.startIndex === waypointIndex) {
			appendCaptureGroup(placemark, range, rangeIndex + 1, options);
		}
	}
	for (let rangeIndex = 0; rangeIndex < route.smartObliqueRanges.length; rangeIndex++) {
		const range = route.smartObliqueRanges[rangeIndex];
		if (range.startIndex === waypointIndex) {
			appendSmartObliqueGroup(placemark, range, route.captureRanges.length + 2 + rangeIndex);
		}
	}
	if (waypointIndex === route.waypoints.length - 1) {
		appendGimbalUnlockGroup(placemark, route.captureRanges.length + 1, waypointIndex);
	}
	const gimbalParam = appendWpmlElement(placemark, 'waypointGimbalHeadingParam');
	appendWpmlElement(gimbalParam, 'waypointGimbalPitchAngle', waypoint.gimbalPitchDegrees ?? route.gimbalPitchDegrees);
	appendWpmlElement(gimbalParam, 'waypointGimbalYawAngle', 0);
	appendWpmlElement(placemark, 'isRisky', 0);
	appendWpmlElement(placemark, 'waypointWorkType', 0);
}

/**
 * 写入跟随航线或固定方向的航点偏航参数。
 */
function appendWaypointHeading(parent: Element, route: ExportRouteData, waypointIndex: number): void {
	const headingParam = appendWpmlElement(parent, 'waypointHeadingParam');
	const isFixedHeading = route.headingDegrees !== undefined;
	appendWpmlElement(headingParam, 'waypointHeadingMode', isFixedHeading ? 'fixed' : 'followWayline');
	const heading = isFixedHeading ? route.headingDegrees! : calculateWaypointHeading(route.waypoints, waypointIndex);
	appendWpmlElement(headingParam, 'waypointHeadingAngle', heading);
	appendWpmlElement(headingParam, 'waypointPoiPoint', '0.000000,0.000000,0.000000');
	appendWpmlElement(headingParam, 'waypointHeadingAngleEnable', 1);
	appendWpmlElement(headingParam, 'waypointHeadingPathMode', 'followBadArc');
	appendWpmlElement(headingParam, 'waypointHeadingPoiIndex', 0);
}

/**
 * 写入首尾停点、中间平滑过点的转弯参数。
 */
function appendWaypointTurn(parent: Element, waypointIndex: number, waypointCount: number): void {
	const turnParam = appendWpmlElement(parent, 'waypointTurnParam');
	const isEndpoint = waypointIndex === 0 || waypointIndex === waypointCount - 1;
	appendWpmlElement(turnParam, 'waypointTurnMode', isEndpoint ? 'toPointAndStopWithDiscontinuityCurvature' : 'toPointAndPassWithContinuityCurvature');
	appendWpmlElement(turnParam, 'waypointTurnDampingDist', 0);
	appendWpmlElement(parent, 'useStraightLine', 1);
}

/**
 * 写入整组航线的云台锁定和俯仰角保持动作。
 */
function appendGimbalLockGroup(parent: Element, route: ExportRouteData): void {
	const actionGroup = appendActionGroup(parent, 0, 0, route.waypoints.length - 1, 'betweenAdjacentPoints');
	const lockAction = appendWpmlElement(actionGroup, 'action');
	appendWpmlElement(lockAction, 'actionId', 0);
	appendWpmlElement(lockAction, 'actionActuatorFunc', 'gimbalAngleLock');
	const lockParam = appendWpmlElement(lockAction, 'actionActuatorFuncParam');
	appendWpmlElement(lockParam, 'payloadPositionIndex', PAYLOAD_POSITION_INDEX);
	const rotateAction = appendWpmlElement(actionGroup, 'action');
	appendWpmlElement(rotateAction, 'actionId', 1);
	appendWpmlElement(rotateAction, 'actionActuatorFunc', 'gimbalRotate');
	appendGimbalRotateParam(rotateAction, route.gimbalPitchDegrees);
}

/**
 * 写入一个拍摄区间的等时或等距拍照动作。
 */
function appendCaptureGroup(parent: Element, range: CaptureRange, actionGroupId: number, options: PlanarKmzExportOptions): void {
	const triggerType = options.photoTriggerMode === 'time' ? 'multipleTiming' : 'multipleDistance';
	// 等时间隔与司空一致：max(Δt_min, D/v)
	const triggerParam =
		options.photoTriggerMode === 'time'
			? Math.max(MINIMUM_PHOTO_INTERVAL_SECONDS, options.photoDistance / options.flightSpeed)
			: options.photoDistance;
	const actionGroup = appendActionGroup(parent, actionGroupId, range.startIndex, range.endIndex, triggerType, triggerParam);
	const action = appendWpmlElement(actionGroup, 'action');
	appendWpmlElement(action, 'actionId', 0);
	appendWpmlElement(action, 'actionActuatorFunc', 'takePhoto');
	const actionParam = appendWpmlElement(action, 'actionActuatorFuncParam');
	appendWpmlElement(actionParam, 'payloadPositionIndex', PAYLOAD_POSITION_INDEX);
	appendWpmlElement(actionParam, 'useGlobalPayloadLensIndex', 0);
	appendWpmlElement(actionParam, 'payloadLensIndex', 'visable');
}

/**
 * 写入一段航带上的智能摆拍姿态序列。
 */
function appendSmartObliqueGroup(parent: Element, range: SmartObliqueRange, actionGroupId: number): void {
	const actionGroup = appendActionGroup(parent, actionGroupId, range.startIndex, range.endIndex, 'betweenAdjacentPoints');
	const action = appendWpmlElement(actionGroup, 'action');
	appendWpmlElement(action, 'actionId', 0);
	appendWpmlElement(action, 'actionActuatorFunc', 'startSmartOblique');
	const actionParam = appendWpmlElement(action, 'actionActuatorFuncParam');
	appendWpmlElement(actionParam, 'smartObliqueCycleMode', 'unlimited');
	appendWpmlElement(actionParam, 'payloadPositionIndex', PAYLOAD_POSITION_INDEX);
	for (let poseIndex = 0; poseIndex < range.poses.length; poseIndex++) {
		const pose = range.poses[poseIndex];
		const point = appendWpmlElement(actionParam, 'smartObliquePoint');
		appendWpmlElement(point, 'smartObliqueRunningTime', 0);
		appendWpmlElement(point, 'smartObliqueStayTime', 0);
		appendWpmlElement(point, 'smartObliqueEulerPitch', pose.pitch);
		appendWpmlElement(point, 'smartObliqueEulerRoll', 0);
		appendWpmlElement(point, 'smartObliqueEulerYaw', pose.yaw);
	}
}

/**
 * 写入末航点的云台解锁动作。
 */
function appendGimbalUnlockGroup(parent: Element, actionGroupId: number, waypointIndex: number): void {
	const actionGroup = appendActionGroup(parent, actionGroupId, waypointIndex, waypointIndex, 'reachPoint');
	const action = appendWpmlElement(actionGroup, 'action');
	appendWpmlElement(action, 'actionId', 0);
	appendWpmlElement(action, 'actionActuatorFunc', 'gimbalAngleUnlock');
}

/**
 * 创建标准 WPML 动作组头部和触发器。
 */
function appendActionGroup(parent: Element, id: number, startIndex: number, endIndex: number, triggerType: string, triggerParam?: number): Element {
	const actionGroup = appendWpmlElement(parent, 'actionGroup');
	appendWpmlElement(actionGroup, 'actionGroupId', id);
	appendWpmlElement(actionGroup, 'actionGroupStartIndex', startIndex);
	appendWpmlElement(actionGroup, 'actionGroupEndIndex', endIndex);
	appendWpmlElement(actionGroup, 'actionGroupMode', 'sequence');
	const trigger = appendWpmlElement(actionGroup, 'actionTrigger');
	appendWpmlElement(trigger, 'actionTriggerType', triggerType);
	if (triggerParam !== undefined) {
		appendWpmlElement(trigger, 'actionTriggerParam', triggerParam);
	}
	return actionGroup;
}

/**
 * 写入 DJI 云台绝对角度动作的完整参数。
 */
function appendGimbalRotateParam(parent: Element, gimbalPitchDegrees: number): void {
	const param = appendWpmlElement(parent, 'actionActuatorFuncParam');
	appendWpmlElement(param, 'gimbalHeadingYawBase', 'aircraft');
	appendWpmlElement(param, 'gimbalRotateMode', 'absoluteAngle');
	appendWpmlElement(param, 'gimbalPitchRotateEnable', 1);
	appendWpmlElement(param, 'gimbalPitchRotateAngle', gimbalPitchDegrees);
	appendWpmlElement(param, 'gimbalRollRotateEnable', 0);
	appendWpmlElement(param, 'gimbalRollRotateAngle', 0);
	appendWpmlElement(param, 'gimbalYawRotateEnable', 0);
	appendWpmlElement(param, 'gimbalYawRotateAngle', 0);
	appendWpmlElement(param, 'gimbalRotateTimeEnable', 0);
	appendWpmlElement(param, 'gimbalRotateTime', 10);
	appendWpmlElement(param, 'payloadPositionIndex', PAYLOAD_POSITION_INDEX);
}

/**
 * 计算正射模式某航点指向下一航点的地理方位角。
 */
function calculateWaypointHeading(waypoints: ExportWaypoint[], waypointIndex: number): number {
	const startIndex = waypointIndex < waypoints.length - 1 ? waypointIndex : waypointIndex - 1;
	const endIndex = waypointIndex < waypoints.length - 1 ? waypointIndex + 1 : waypointIndex;
	const start = waypoints[startIndex];
	const end = waypoints[endIndex];
	const startLatitude = Cesium.Math.toRadians(start.latitude);
	const endLatitude = Cesium.Math.toRadians(end.latitude);
	const longitudeDelta = Cesium.Math.toRadians(end.longitude - start.longitude);
	const east = Math.sin(longitudeDelta) * Math.cos(endLatitude);
	const north = Math.cos(startLatitude) * Math.sin(endLatitude) - Math.sin(startLatitude) * Math.cos(endLatitude) * Math.cos(longitudeDelta);
	return normalizeHeading(Cesium.Math.toDegrees(Math.atan2(east, north)));
}

/**
 * 将有向航向角归一化到 -180°~180°。
 */
function normalizeHeading(angle: number): number {
	const normalized = ((angle % 360) + 360) % 360;
	return normalized > 180 ? normalized - 360 : normalized;
}

/**
 * 将主航线无向角归一化到 DJI 模板接受的 0°~360°。
 */
function normalizeDirection(angle: number): number {
	return ((angle % 360) + 360) % 360;
}

/**
 * 将页面高度模式映射为 DJI 模板高度模式。
 * 相对地形按司空建图仿地：EGM96 + surfaceFollowModeEnable，而不是 aboveGroundLevel。
 */
function getTemplateHeightMode(heightType: number): 'EGM96' | 'relativeToStartPoint' {
	if (heightType === 2) {
		return 'relativeToStartPoint';
	}
	return 'EGM96';
}

/**
 * 将页面高度模式映射为 waylines.wpml 的执行高度模式。
 */
function getExecuteHeightMode(heightType: number): 'WGS84' | 'relativeToStartPoint' {
	if (heightType === 2) {
		return 'relativeToStartPoint';
	}
	return 'WGS84';
}

/**
 * 创建并追加一个 KML 命名空间元素。
 */
function appendKmlElement(parent: Element, name: string, value?: string | number): Element {
	const element = parent.ownerDocument.createElementNS(KML_NAMESPACE, name);
	if (value !== undefined) {
		element.textContent = typeof value === 'number' ? formatNumber(value) : value;
	}
	parent.appendChild(element);
	return element;
}

/**
 * 创建并追加一个 wpml 前缀元素。
 */
function appendWpmlElement(parent: Element, name: string, value?: string | number): Element {
	const element = parent.ownerDocument.createElementNS(WPML_NAMESPACE, `wpml:${name}`);
	if (value !== undefined) {
		element.textContent = typeof value === 'number' ? formatNumber(value) : value;
	}
	parent.appendChild(element);
	return element;
}

/**
 * 序列化 XML 并补充 UTF-8 声明。
 */
function serializeXml(xmlDocument: XMLDocument): string {
	return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(xmlDocument)}`;
}

/**
 * 限制 XML 数字精度并移除无意义的尾随零。
 */
function formatNumber(value: number): string {
	if (!Number.isFinite(value)) {
		throw new Error('KMZ 中存在无效数值');
	}
	return Number(value.toFixed(8)).toString();
}
