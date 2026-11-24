/**
 * 功能名称：面状航线 KMZ 导入解析
 * 日    期：2026/07/20
 */
import JSZip from 'jszip';

export type PlanarKmzTemplateType = 'mapping2d' | 'mapping3d';
export type PlanarKmzHeightMode = 'WGS84' | 'relativeToStartPoint' | 'realTimeFollowSurface';
export type PlanarKmzPhotoTriggerMode = 'time' | 'distance';

export interface PlanarKmzCoordinate {
	longitude: number;
	latitude: number;
	height: number;
}

export interface PlanarKmzCaptureRange {
	id: number;
	startIndex: number;
	endIndex: number;
	triggerMode: PlanarKmzPhotoTriggerMode;
	triggerParam?: number;
}

export interface PlanarKmzImportedRoute {
	id: number;
	headingDegrees?: number;
	gimbalPitchDegrees: number;
	heightMode: PlanarKmzHeightMode;
	waypoints: PlanarKmzCoordinate[];
	captureRanges: PlanarKmzCaptureRange[];
}

export interface PlanarKmzImportResult {
	templateType: PlanarKmzTemplateType;
	polygon: PlanarKmzCoordinate[];
	takeoffPosition?: PlanarKmzCoordinate;
	heightType?: number;
	lineHeight?: number;
	speed?: number;
	transitionalSpeed?: number;
	overlapW?: number;
	overlapH?: number;
	lineAngle?: number;
	photoTriggerMode?: PlanarKmzPhotoTriggerMode;
	photoDistance?: number;
	gimbalPitchDegrees?: number;
	smartObliqueEnable?: boolean;
	smartObliqueSwingAngle?: number;
	routes: PlanarKmzImportedRoute[];
	warnings: string[];
}

interface ParsedDocument {
	document: XMLDocument;
	root: Element;
}

interface ParsedWaypoint extends PlanarKmzCoordinate {
	index: number;
}

const SUPPORTED_TEMPLATE_TYPES = new Set<PlanarKmzTemplateType>(['mapping2d', 'mapping3d']);

/**
 * 解析面状航线 KMZ。仅接受 mapping2d 和 mapping3d 模板。
 */
export async function parsePlanarKmz(file: Blob): Promise<PlanarKmzImportResult> {
	const zip = await loadZip(file);
	const templateXml = await readZipXml(zip, 'template.kml');
	const waylinesXml = await readZipXml(zip, 'waylines.wpml');
	const template = parseXml(templateXml, 'template.kml');
	const waylines = parseXml(waylinesXml, 'waylines.wpml');
	const templateFolder = findTemplateFolder(template.root);
	const templateType = readTemplateType(templateFolder);
	if (!SUPPORTED_TEMPLATE_TYPES.has(templateType)) {
		throw new Error('仅支持 mapping2d 和 mapping3d 面状航线');
	}

	const warnings: string[] = [];
	const polygon = parsePolygon(templateFolder);
	if (polygon.length < 3) {
		throw new Error('KMZ 中缺少有效测区，至少需要三个测区顶点');
	}

	const waylineDocument = findDocument(waylines.document);
	const missionConfig = findDirectChild(template.root, 'missionConfig');
	const waylineMissionConfig = findDirectChild(waylineDocument, 'missionConfig');
	const coordinateParam = findDirectChild(templateFolder, 'waylineCoordinateSysParam');
	const templatePlacemark = findDirectChild(templateFolder, 'Placemark');
	const takeoffPosition = parseTakeoffPosition(missionConfig) ?? parseTakeoffPosition(waylineMissionConfig);
	let heightType = parseHeightType(coordinateParam);
	const lineHeight = parseLineHeight(templateFolder, coordinateParam, templatePlacemark);
	let speed = parseNumber(findDirectChild(templateFolder, 'autoFlightSpeed'));
	const transitionalSpeed = parseNumber(findDirectChild(missionConfig, 'globalTransitionalSpeed')) ?? parseNumber(findDirectChild(waylineMissionConfig, 'globalTransitionalSpeed'));
	let photoTriggerMode = parsePhotoTriggerMode(templatePlacemark);
	const overlap = parseOverlap(templatePlacemark, templateType);
	const lineAngle = parseLineAngle(templatePlacemark);
	const templateGimbalPitch = parseNumber(findDirectChild(templatePlacemark, 'inclinedGimbalPitch'));
	const smartObliqueEnable = readText(findDirectChild(templatePlacemark, 'smartObliqueEnable')) === '1';
	const smartObliquePitch = parseNumber(findDirectChild(templatePlacemark, 'smartObliqueGimbalPitch'));
	const smartObliqueSwingAngle = smartObliquePitch === undefined ? undefined : Math.min(45, Math.max(10, Math.abs(smartObliquePitch)));

	const folders = findDirectChildren(waylineDocument, 'Folder');
	const routes: PlanarKmzImportedRoute[] = [];
	for (let folderIndex = 0; folderIndex < folders.length; folderIndex++) {
		const route = parseRoute(folders[folderIndex], folderIndex, photoTriggerMode);
		if (route.waypoints.length < 2) {
			continue;
		}
		routes.push(route);
	}

	if (routes.length === 0) {
		throw new Error('KMZ 中缺少有效航线航点');
	}
	if (templateType === 'mapping2d' && routes.length !== 1) {
		throw new Error('mapping2d 文件必须包含一组有效航线');
	}
	if (templateType === 'mapping3d' && smartObliqueEnable && routes.length !== 1) {
		throw new Error('智能摆拍航线必须包含一组有效航线');
	}
	if (templateType === 'mapping3d' && !smartObliqueEnable && routes.length !== 5) {
		throw new Error('mapping3d 文件必须包含五组有效航线');
	}
	if (speed === undefined) {
		speed = parseNumber(findDirectChild(folders[0], 'autoFlightSpeed'));
	}
	if (heightType === undefined) {
		heightType = mapExecuteHeightMode(routes[0].heightMode);
	}
	if (photoTriggerMode === undefined && routes[0].captureRanges.length > 0) {
		photoTriggerMode = routes[0].captureRanges[0].triggerMode;
	}
	let gimbalPitch = templateGimbalPitch;
	if (gimbalPitch === undefined && templateType === 'mapping3d') {
		for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
			if (routes[routeIndex].gimbalPitchDegrees > -90) {
				gimbalPitch = routes[routeIndex].gimbalPitchDegrees;
				break;
			}
		}
	}

	const photoDistance = parsePhotoDistance(routes, speed);
	const result: PlanarKmzImportResult = {
		templateType,
		polygon,
		takeoffPosition,
		heightType,
		lineHeight,
		speed,
		transitionalSpeed,
		overlapW: overlap.overlapW,
		overlapH: overlap.overlapH,
		lineAngle,
		photoTriggerMode,
		photoDistance,
		gimbalPitchDegrees: gimbalPitch,
		smartObliqueEnable,
		smartObliqueSwingAngle,
		routes,
		warnings,
	};
	appendMissingFieldWarnings(result);
	return result;
}

/**
 * 将 ZIP 文件中的 XML 内容读取为字符串。
 */
async function loadZip(file: Blob): Promise<JSZip> {
	try {
		return await JSZip.loadAsync(file);
	} catch {
		throw new Error('KMZ 文件解压失败，请确认文件格式正确');
	}
}

/**
 * 按大小写不敏感的文件名读取 XML。
 */
async function readZipXml(zip: JSZip, expectedName: string): Promise<string> {
	let targetPath: string | undefined;
	zip.forEach((relativePath, entry) => {
		const fileName = relativePath.split('/').pop() ?? relativePath;
		if (fileName.toLowerCase() === expectedName.toLowerCase() && !entry.dir) {
			targetPath = relativePath;
		}
	});
	const target = targetPath ? zip.file(targetPath) : null;
	if (!target) {
		throw new Error(`KMZ 中缺少 ${expectedName}`);
	}
	return await target.async('string');
}

/**
 * 将 XML 字符串解析为 DOM，并统一处理解析错误。
 */
function parseXml(xml: string, fileName: string): ParsedDocument {
	const document = new DOMParser().parseFromString(xml, 'text/xml');
	if (document.getElementsByTagName('parsererror').length > 0) {
		throw new Error(`${fileName} XML 解析失败`);
	}
	const root = findDocument(document);
	return { document, root };
}

/**
 * 获取 KML Document 节点。
 */
function findDocument(document: XMLDocument): Element {
	if (document.documentElement && localName(document.documentElement) === 'Document') {
		return document.documentElement;
	}
	const documentNode = findDescendant(document.documentElement, 'Document');
	if (!documentNode) {
		throw new Error('KMZ XML 中缺少 Document 节点');
	}
	return documentNode;
}

/**
 * 获取 template.kml 中的模板 Folder。
 */
function findTemplateFolder(document: Element): Element {
	const folders = findDirectChildren(document, 'Folder');
	if (folders.length === 0) {
		throw new Error('template.kml 中缺少模板 Folder');
	}
	return folders[0];
}

/**
 * 读取模板类型并校验为支持的面状类型。
 */
function readTemplateType(folder: Element): PlanarKmzTemplateType {
	const value = readText(findDirectChild(folder, 'templateType'));
	if (value === 'mapping2d' || value === 'mapping3d') {
		return value;
	}
	if (value) {
		throw new Error(`暂不支持 ${value} 航线类型`);
	}
	throw new Error('KMZ 中缺少航线模板类型');
}

/**
 * 读取 template.kml 的测区外环坐标。
 */
function parsePolygon(folder: Element): PlanarKmzCoordinate[] {
	const polygonNode = findDescendant(folder, 'Polygon');
	const ringNode = polygonNode ? findDescendant(polygonNode, 'LinearRing') : null;
	const coordinatesNode = ringNode ? findDirectChild(ringNode, 'coordinates') : null;
	const raw = readText(coordinatesNode);
	if (!raw) {
		return [];
	}
	const result: PlanarKmzCoordinate[] = [];
	const tokens = raw.trim().split(/\s+/g);
	for (let index = 0; index < tokens.length; index++) {
		const coordinate = parseCoordinate(tokens[index], 0);
		if (!coordinate) {
			continue;
		}
		const previous = result[result.length - 1];
		if (!previous || !sameCoordinate(previous, coordinate)) {
			result.push(coordinate);
		}
	}
	if (result.length > 1 && sameCoordinate(result[0], result[result.length - 1])) {
		result.pop();
	}
	return result;
}

/**
 * 读取任务参考起飞点，WPML 顺序为纬度、经度、椭球高。
 */
function parseTakeoffPosition(missionConfig: Element | null): PlanarKmzCoordinate | undefined {
	const raw = readText(findDirectChild(missionConfig, 'takeOffRefPoint'));
	if (!raw) {
		return undefined;
	}
	const values = raw.split(',');
	if (values.length < 3) {
		return undefined;
	}
	const latitude = Number(values[0]);
	const longitude = Number(values[1]);
	const height = Number(values[2]);
	if (!isValidCoordinate(longitude, latitude, height)) {
		return undefined;
	}
	return { longitude, latitude, height };
}

/**
 * 将模板高度模式映射到页面高度模式。
 */
function parseHeightType(coordinateParam: Element | null): number | undefined {
	const heightMode = readText(findDirectChild(coordinateParam, 'heightMode'));
	const surfaceFollow = parseNumber(findDirectChild(coordinateParam, 'surfaceFollowModeEnable'));
	if (surfaceFollow === 1 || heightMode === 'aboveGroundLevel') {
		return 3;
	}
	if (heightMode === 'relativeToStartPoint') {
		return 2;
	}
	if (heightMode === 'EGM96' || heightMode === 'WGS84') {
		return 1;
	}
	return undefined;
}

/**
 * 将执行高度模式映射到页面高度模式。
 */
function mapExecuteHeightMode(heightMode: PlanarKmzHeightMode): number {
	if (heightMode === 'relativeToStartPoint') {
		return 2;
	}
	if (heightMode === 'realTimeFollowSurface') {
		return 3;
	}
	return 1;
}

/**
 * 读取全局航线高度，仿地模式优先使用 surfaceRelativeHeight。
 */
function parseLineHeight(folder: Element, coordinateParam: Element | null, placemark: Element | null): number | undefined {
	const surfaceFollow = parseNumber(findDirectChild(coordinateParam, 'surfaceFollowModeEnable'));
	if (surfaceFollow === 1) {
		const surfaceHeight = parseNumber(findDirectChild(coordinateParam, 'surfaceRelativeHeight'));
		if (surfaceHeight !== undefined) {
			return surfaceHeight;
		}
	}
	const globalHeight = parseNumber(findDirectChild(coordinateParam, 'globalShootHeight'));
	if (globalHeight !== undefined) {
		return globalHeight;
	}
	const folderHeight = parseNumber(findDirectChild(folder, 'globalHeight'));
	if (folderHeight !== undefined) {
		return folderHeight;
	}
	return parseNumber(findDirectChild(placemark, 'height'));
}

/**
 * 读取拍照触发模式。
 */
function parsePhotoTriggerMode(placemark: Element | null): PlanarKmzPhotoTriggerMode | undefined {
	const value = readText(findDirectChild(placemark, 'shootType'));
	if (value === 'time' || value === 'distance') {
		return value;
	}
	return undefined;
}

/**
 * 读取正射或倾斜重叠率。
 */
function parseOverlap(placemark: Element | null, templateType: PlanarKmzTemplateType): { overlapW?: number; overlapH?: number } {
	const overlap = findDirectChild(placemark, 'overlap');
	const widthName = templateType === 'mapping3d' ? 'inclinedCameraOverlapW' : 'orthoCameraOverlapW';
	const heightName = templateType === 'mapping3d' ? 'inclinedCameraOverlapH' : 'orthoCameraOverlapH';
	return {
		overlapW: parseNumber(findDirectChild(overlap, widthName)),
		overlapH: parseNumber(findDirectChild(overlap, heightName)),
	};
}

/**
 * 读取模板方向并归一化到页面的 0 至 179 度范围。
 */
function parseLineAngle(placemark: Element | null): number | undefined {
	const direction = parseNumber(findDirectChild(placemark, 'direction'));
	if (direction === undefined) {
		return undefined;
	}
	const normalized = ((direction % 180) + 180) % 180;
	return normalized;
}

/**
 * 读取一组 waylines Folder。
 */
function parseRoute(folder: Element, folderIndex: number, templateTriggerMode: PlanarKmzPhotoTriggerMode | undefined): PlanarKmzImportedRoute {
	const heightModeValue = readText(findDirectChild(folder, 'executeHeightMode'));
	const heightMode: PlanarKmzHeightMode = heightModeValue === 'relativeToStartPoint' || heightModeValue === 'realTimeFollowSurface' ? heightModeValue : 'WGS84';
	const placemarks = findDirectChildren(folder, 'Placemark');
	const waypoints: ParsedWaypoint[] = [];
	for (let index = 0; index < placemarks.length; index++) {
		const waypoint = parseWaypoint(placemarks[index], index);
		if (waypoint) {
			waypoints.push(waypoint);
		}
	}
	waypoints.sort((left, right) => left.index - right.index);
	const headingParam = findDirectChild(placemarks[0], 'waypointHeadingParam');
	const headingMode = readText(findDirectChild(headingParam, 'waypointHeadingMode'));
	const heading = headingMode === 'fixed' ? parseNumber(findDirectChild(headingParam, 'waypointHeadingAngle')) : undefined;
	const gimbalPitch = parseRouteGimbalPitch(folder, placemarks);
	const captureRanges = parseCaptureRanges(folder, templateTriggerMode);
	const id = folderIndex + 1;
	return {
		id,
		headingDegrees: heading,
		gimbalPitchDegrees: gimbalPitch,
		heightMode,
		waypoints,
		captureRanges,
	};
}

/**
 * 读取单个执行航点。
 */
function parseWaypoint(placemark: Element, fallbackIndex: number): ParsedWaypoint | undefined {
	const point = findDirectChild(placemark, 'Point');
	const coordinateNode = findDirectChild(point, 'coordinates');
	const coordinateText = readText(coordinateNode);
	if (!coordinateText) {
		return undefined;
	}
	const coordinate = parseCoordinate(coordinateText, 0);
	const executeHeight = parseNumber(findDirectChild(placemark, 'executeHeight')) ?? parseNumber(findDirectChild(placemark, 'height'));
	if (!coordinate || executeHeight === undefined) {
		return undefined;
	}
	const indexValue = parseNumber(findDirectChild(placemark, 'index'));
	return { ...coordinate, height: executeHeight, index: indexValue === undefined ? fallbackIndex : indexValue };
}

/**
 * 读取航线级云台俯仰角。
 */
function parseRouteGimbalPitch(folder: Element, placemarks: Element[]): number {
	const startActionGroup = findDirectChild(folder, 'startActionGroup');
	const actionParam = findDescendant(startActionGroup, 'actionActuatorFuncParam');
	const startPitch = parseNumber(findDirectChild(actionParam, 'gimbalPitchRotateAngle'));
	if (startPitch !== undefined) {
		return startPitch;
	}
	const gimbalParam = findDirectChild(placemarks[0], 'waypointGimbalHeadingParam');
	const waypointPitch = parseNumber(findDirectChild(gimbalParam, 'waypointGimbalPitchAngle'));
	return waypointPitch === undefined ? -90 : waypointPitch;
}

/**
 * 读取拍照动作区间，用于恢复拍摄航段与照片统计。
 */
function parseCaptureRanges(folder: Element, templateTriggerMode: PlanarKmzPhotoTriggerMode | undefined): PlanarKmzCaptureRange[] {
	const actionGroups = findDescendants(folder, 'actionGroup');
	const ranges: PlanarKmzCaptureRange[] = [];
	const intervalTriggers = new Map<string, { mode: PlanarKmzPhotoTriggerMode; param?: number }>();
	for (let index = 0; index < actionGroups.length; index++) {
		const actionGroup = actionGroups[index];
		const start = parseNumber(findDirectChild(actionGroup, 'actionGroupStartIndex'));
		const end = parseNumber(findDirectChild(actionGroup, 'actionGroupEndIndex'));
		const trigger = findDirectChild(actionGroup, 'actionTrigger');
		const triggerType = readText(findDirectChild(trigger, 'actionTriggerType'));
		if (start === undefined || end === undefined || (triggerType !== 'multipleTiming' && triggerType !== 'multipleDistance')) {
			continue;
		}
		intervalTriggers.set(`${start}:${end}`, {
			mode: triggerType === 'multipleDistance' ? 'distance' : 'time',
			param: parseNumber(findDirectChild(trigger, 'actionTriggerParam')),
		});
	}

	for (let index = 0; index < actionGroups.length; index++) {
		const actionGroup = actionGroups[index];
		const trigger = findDirectChild(actionGroup, 'actionTrigger');
		const triggerType = readText(findDirectChild(trigger, 'actionTriggerType'));
		const actions = findDirectChildren(actionGroup, 'action');
		let hasPhotoAction = false;
		let hasTimeLapseAction = false;
		for (let actionIndex = 0; actionIndex < actions.length; actionIndex++) {
			const actionType = readText(findDirectChild(actions[actionIndex], 'actionActuatorFunc'));
			if (actionType === 'takePhoto') {
				hasPhotoAction = true;
			}
			if (actionType === 'startTimeLapse') {
				hasTimeLapseAction = true;
			}
		}
		if (!hasPhotoAction && !hasTimeLapseAction) {
			continue;
		}
		const start = parseNumber(findDirectChild(actionGroup, 'actionGroupStartIndex'));
		const end = parseNumber(findDirectChild(actionGroup, 'actionGroupEndIndex'));
		if (start === undefined || end === undefined || end < start) {
			continue;
		}
		const matchingInterval = intervalTriggers.get(`${start}:${end}`);
		let triggerMode = templateTriggerMode ?? 'time';
		let triggerParam: number | undefined;
		if (triggerType === 'multipleTiming' || triggerType === 'multipleDistance') {
			triggerMode = triggerType === 'multipleDistance' ? 'distance' : 'time';
			triggerParam = parseNumber(findDirectChild(trigger, 'actionTriggerParam'));
		} else if (matchingInterval) {
			triggerMode = matchingInterval.mode;
			triggerParam = matchingInterval.param;
		}
		const actionGroupId = parseNumber(findDirectChild(actionGroup, 'actionGroupId'));
		ranges.push({ id: actionGroupId ?? index + 1, startIndex: start, endIndex: end, triggerMode, triggerParam });
	}
	return ranges;
}

/**
 * 根据拍照动作参数换算等距拍照间隔。
 */
function parsePhotoDistance(routes: PlanarKmzImportedRoute[], speed: number | undefined): number | undefined {
	for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
		const ranges = routes[routeIndex].captureRanges;
		for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
			const range = ranges[rangeIndex];
			if (range.triggerParam === undefined) {
				continue;
			}
			if (range.triggerMode === 'distance') {
				return range.triggerParam;
			}
			if (range.triggerMode === 'time' && speed !== undefined && speed > 0) {
				return range.triggerParam * speed;
			}
		}
	}
	return undefined;
}

/**
 * 汇总缺省字段，交由页面使用默认值并提示用户。
 */
function appendMissingFieldWarnings(result: PlanarKmzImportResult): void {
	if (!result.takeoffPosition) {
		result.warnings.push('文件缺少参考起飞点，请在页面中重新设置');
	}
	if (result.heightType === undefined) {
		result.warnings.push('文件缺少高度模式，已使用页面默认值');
	}
	if (result.lineHeight === undefined) {
		result.warnings.push('文件缺少航线高度，已使用页面默认值');
	}
	if (result.speed === undefined) {
		result.warnings.push('文件缺少航线速度，已使用页面默认值');
	}
	if (result.transitionalSpeed === undefined) {
		result.warnings.push('文件缺少起飞速度，已使用页面默认值');
	}
	if (result.overlapW === undefined || result.overlapH === undefined) {
		result.warnings.push('文件缺少重叠率，已使用页面默认值');
	}
	if (result.lineAngle === undefined) {
		result.warnings.push('文件缺少主航线角度，已使用页面默认值');
	}
	if (result.templateType === 'mapping3d' && result.gimbalPitchDegrees === undefined) {
		result.warnings.push('文件缺少倾斜云台角度，已使用页面默认值');
	}
	if (result.photoTriggerMode === undefined || result.photoDistance === undefined) {
		result.warnings.push('文件缺少拍照触发参数，已使用页面默认值');
	}
}

/**
 * 获取直接子节点。
 */
function findDirectChild(parent: Element | null | undefined, name: string): Element | null {
	if (!parent) {
		return null;
	}
	const childNodes = Array.from(parent.childNodes);
	for (let index = 0; index < childNodes.length; index++) {
		const node = childNodes[index];
		if (node.nodeType === 1 && localName(node as Element) === name) {
			return node as Element;
		}
	}
	return null;
}

/**
 * 获取全部直接子节点。
 */
function findDirectChildren(parent: Element | null | undefined, name: string): Element[] {
	if (!parent) {
		return [];
	}
	const result: Element[] = [];
	const childNodes = Array.from(parent.childNodes);
	for (let index = 0; index < childNodes.length; index++) {
		const node = childNodes[index];
		if (node.nodeType === 1 && localName(node as Element) === name) {
			result.push(node as Element);
		}
	}
	return result;
}

/**
 * 获取第一个后代节点。
 */
function findDescendant(parent: ParentNode | null | undefined, name: string): Element | null {
	const descendants = findDescendants(parent, name);
	return descendants[0] ?? null;
}

/**
 * 获取全部后代节点。
 */
function findDescendants(parent: ParentNode | null | undefined, name: string): Element[] {
	if (!parent) {
		return [];
	}
	const result: Element[] = [];
	const pending = Array.from(parent.childNodes);
	for (let index = 0; index < pending.length; index++) {
		const node = pending[index];
		if (node.nodeType !== 1) {
			continue;
		}
		const element = node as Element;
		if (localName(element) === name) {
			result.push(element);
		}
		const childNodes = Array.from(element.childNodes);
		for (let childIndex = 0; childIndex < childNodes.length; childIndex++) {
			pending.push(childNodes[childIndex]);
		}
	}
	return result;
}

/**
 * 获取不含命名空间前缀的 XML 节点名。
 */
function localName(element: Element): string {
	if (element.localName) {
		return element.localName;
	}
	const separatorIndex = element.nodeName.indexOf(':');
	return separatorIndex >= 0 ? element.nodeName.slice(separatorIndex + 1) : element.nodeName;
}

/**
 * 读取节点文本。
 */
function readText(element: Element | null): string | undefined {
	if (!element || element.textContent === null) {
		return undefined;
	}
	const value = element.textContent.trim();
	return value.length > 0 ? value : undefined;
}

/**
 * 读取有限数值。
 */
function parseNumber(element: Element | null): number | undefined {
	const text = readText(element);
	if (!text) {
		return undefined;
	}
	const value = Number(text);
	return Number.isFinite(value) ? value : undefined;
}

/**
 * 解析逗号分隔的经纬高坐标。
 */
function parseCoordinate(raw: string, defaultHeight: number): PlanarKmzCoordinate | undefined {
	const values = raw.trim().split(',');
	if (values.length < 2) {
		return undefined;
	}
	const longitude = Number(values[0]);
	const latitude = Number(values[1]);
	const height = values.length >= 3 && values[2] !== '' ? Number(values[2]) : defaultHeight;
	if (!isValidCoordinate(longitude, latitude, height)) {
		return undefined;
	}
	return { longitude, latitude, height };
}

/**
 * 校验经纬高坐标。
 */
function isValidCoordinate(longitude: number, latitude: number, height: number): boolean {
	return Number.isFinite(longitude) && Number.isFinite(latitude) && Number.isFinite(height) && longitude >= -180 && longitude <= 180 && latitude >= -90 && latitude <= 90;
}

/**
 * 判断两个坐标是否重复。
 */
function sameCoordinate(left: PlanarKmzCoordinate, right: PlanarKmzCoordinate): boolean {
	return Math.abs(left.longitude - right.longitude) <= 1e-10 && Math.abs(left.latitude - right.latitude) <= 1e-10;
}
