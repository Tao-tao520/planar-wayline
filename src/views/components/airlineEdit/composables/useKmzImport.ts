/**
 * 功能名称：面状航线 KMZ 导入逻辑
 * 日    期：2026/07/29
 */
import * as Cesium from 'cesium';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Ref } from 'vue';
import { fieldOfViewFromLens } from '../config/cameraConfig';
import { getSelectedAircraft } from '../config/selectedAircraft';
import globeConfig, { calculateMaxFlightSpeed, PLANAR_EDIT_DEFAULTS, PLANAR_SPEED_HARD_MAX } from '../config/planarConfig';
import { drawImportedPolygon, PolygonDrawingResult } from '../utils/drawPolygon';
import { drawFlyStartLine } from '../utils/planarLine';
import { calculatePhotoDistance } from '../utils/wayLineCalc';
import { roundPlanarRouteSegments } from '../utils/planarRouteTurn';
import {
	CartesianRouteSegment,
	createLocalCoordinateFrame,
	LocalCoordinateFrame,
	LocalRouteSegment,
	sampleTerrainHeightsAtPositions,
} from '../utils/planarTerrain';
import { parsePlanarKmz, PlanarKmzCoordinate, PlanarKmzImportResult, PlanarKmzImportedRoute } from '../utils/planarKmzImport';
import { LocalPoint, PlanarRouteSegment } from '../utils/wayLineCalc';
import type { FiveDirectionRouteKey } from '../utils/obliqueRoute';

const IMPORT_VIEW_MINIMUM_RANGE = 1000;
const IMPORT_VIEW_SAFE_ABSOLUTE_HEIGHT = 12000;
const IMPORT_TERRAIN_IDLE_DELAY = 3000;

export interface ImportedConfigValues {
	heightType: number;
	lineHeight: number;
	speed: number;
	maxSpeed: number;
	takeoffSpeed: number;
	overlapW: number;
	overlapH: number;
	lineAngle: number;
	photoTriggerMode: 'time' | 'distance';
	smartObliqueGimbalPitch: number;
	photoDistance: number;
}

export interface PreparedImportedRoute {
	route: PlanarKmzImportedRoute;
	exportSegments: CartesianRouteSegment[];
}

export interface PlannedRouteData {
	id: number;
	key: FiveDirectionRouteKey;
	label: string;
	headingDegrees?: number;
	gimbalPitchDegrees: number;
	segments: CartesianRouteSegment[];
	exportSegments: CartesianRouteSegment[];
	coordinates: number[];
	totalLength: number;
	climbLength: number;
	photoCount: number;
}

/** KMZ 导入所需的外部上下文（由 Instance 提供） */
export interface KmzImportContext {
	isImporting: Ref<boolean>;
	entityObjPolygonObj: PolygonDrawingResult | null;
	hasRoute: Ref<boolean>;
	routeCalculationVersion: number;
	isLineAngleManual: boolean;
	/** 设置 entityObjPolygonObj */
	setEntityObjPolygonObj: (value: PolygonDrawingResult | null) => void;
	/** 设置 isLineAngleManual */
	setIsLineAngleManual: (value: boolean) => void;
	/** 增加版本号 */
	bumpVersion: () => number;
	/** 清理旧状态 */
	clearCurrentRouteState: (preserveTakeoff: boolean) => void;
	/** 注册多边形交互 */
	setupPolygonSubscriber: () => void;
	/** 启用测区右键删除 */
	enablePolygonRightClick: () => void;
	/** 应用规划航线 */
	applyPlannedRoutes: (routes: PlannedRouteData[], photoDistance: number) => void;
	/** 等待预览就绪 */
	waitForRoutePreviewReady: (version: number) => Promise<void>;
	/** 连接起飞点到首航点 */
	connectTakeoffToFirstWaypoint: (segments: CartesianRouteSegment[]) => { segments: CartesianRouteSegment[]; climbLength: number };
	/** 统计照片数 */
	calculateRoutePhotoCount: (segments: CartesianRouteSegment[], photoDistance: number, splitCaptureGroups: boolean) => number;
	/** 展平坐标 */
	flattenRouteCoordinates: (segments: CartesianRouteSegment[]) => number[];
}

export class KmzImportHandler {
	private ctx: KmzImportContext;
	private importedPolygonNeedsSafeView = false;
	private importedTerrainLoadCleanup: (() => void) | null = null;
	private importedTerrainIdleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(ctx: KmzImportContext) {
		this.ctx = ctx;
	}

	/**
	 * 取消尚未执行的导入地形修正监听和定时器。
	 */
	cancelImportedTerrainCorrection(): void {
		this.importedTerrainLoadCleanup?.();
		this.importedTerrainLoadCleanup = null;
		if (this.importedTerrainIdleTimer) {
			clearTimeout(this.importedTerrainIdleTimer);
			this.importedTerrainIdleTimer = null;
		}
	}

	/**
	 * 从远程 KMZ 地址下载并导入面状航线。
	 */
	async importPlanarKmzFromUrl(fileUrl: string, waylineName?: string): Promise<void> {
		const response = await fetch(fileUrl);
		if (!response.ok) {
			throw new Error(`获取航线文件失败: ${response.statusText}`);
		}
		const blob = await response.blob();
		const filename = waylineName ? `${waylineName}.kmz` : 'wayline.kmz';
		const file = new File([blob], filename, { type: 'application/vnd.google-earth.kmz' });
		await this.importPlanarKmz(file);
	}

	/**
	 * 校验、确认并原子替换当前面状航线。
	 */
	async importPlanarKmz(file: File): Promise<void> {
		if (!window.mainViewer || !window.mainViewer.dataSources) {
			ElMessage.warning('地图尚未加载完成');
			return;
		}
		if (!file.name.toLowerCase().endsWith('.kmz')) {
			ElMessage.warning('请选择 KMZ 航线文件');
			return;
		}

		this.ctx.isImporting.value = true;
		try {
			const imported = await parsePlanarKmz(file);
			const warnings = [...imported.warnings];
			const config = this.normalizeImportedConfig(imported, warnings);
			const shouldReplace = await this.confirmImportedRouteReplacement();
			if (!shouldReplace) {
				return;
			}
			const preparedRoutes = await this.prepareImportedRoutes(imported, warnings);
			const polygonPositions = await this.resolveImportedPolygonPositions(imported.polygon, warnings);
			this.applyImportedRoute(imported, config, preparedRoutes, polygonPositions);
			const version = this.ctx.routeCalculationVersion;
			await this.ctx.waitForRoutePreviewReady(version);
			if (version !== this.ctx.routeCalculationVersion) {
				return;
			}
			ElMessage.success('航线导入成功');
			if (warnings.length > 0) {
				const uniqueWarnings = Array.from(new Set(warnings));
				ElMessage.warning({ message: uniqueWarnings.join('；'), duration: 8000 });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : '航线导入失败';
			ElMessage.error(message);
		} finally {
			this.ctx.isImporting.value = false;
		}
	}

	/**
	 * 当前已有内容时询问是否替换。
	 */
	private async confirmImportedRouteReplacement(): Promise<boolean> {
		if (!this.ctx.entityObjPolygonObj && !this.ctx.hasRoute.value) {
			return true;
		}
		try {
			await ElMessageBox.confirm('导入航线将替换当前测区和航线，是否继续？', '导入航线', {
				type: 'warning',
				confirmButtonText: '继续导入',
				cancelButtonText: '取消',
			});
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * 使用页面默认值补齐缺省字段，并限制导入参数到现有控件范围。
	 */
	private normalizeImportedConfig(imported: PlanarKmzImportResult, warnings: string[]): ImportedConfigValues {
		const heightType = imported.heightType === 1 || imported.heightType === 2 || imported.heightType === 3 ? imported.heightType : PLANAR_EDIT_DEFAULTS.heightType;
		const lineHeight = this.clampImportedNumber(imported.lineHeight, PLANAR_EDIT_DEFAULTS.lineHeight, 2, 1500, '航线高度', warnings);
		const takeoffSpeed = this.clampImportedNumber(imported.transitionalSpeed, PLANAR_EDIT_DEFAULTS.takeoffSpeed, 1, 15, '起飞速度', warnings);
		const overlapW = this.clampImportedNumber(imported.overlapW, PLANAR_EDIT_DEFAULTS.overlapW, 10, 90, '旁向重叠率', warnings);
		const overlapH = this.clampImportedNumber(imported.overlapH, PLANAR_EDIT_DEFAULTS.overlapH, 10, 90, '航向重叠率', warnings);
		const lineAngle = this.clampImportedNumber(imported.lineAngle, PLANAR_EDIT_DEFAULTS.lineAngle, 0, 179, '主航线角度', warnings);
		const smartObliqueGimbalPitch = this.clampImportedNumber(imported.gimbalPitchDegrees, PLANAR_EDIT_DEFAULTS.smartObliqueGimbalPitch, -85, -40, '云台俯仰角', warnings);
		const photoTriggerMode = imported.photoTriggerMode ?? PLANAR_EDIT_DEFAULTS.photoTriggerMode;
		const cameraFieldOfView = fieldOfViewFromLens(getSelectedAircraft().wideCamera);
		const fallbackPhotoDistance = calculatePhotoDistance(lineHeight, cameraFieldOfView.verticalDegrees, overlapH);
		const photoDistance = imported.photoDistance && imported.photoDistance > 0 ? imported.photoDistance : fallbackPhotoDistance;
		const maxSpeed = Number(calculateMaxFlightSpeed(photoDistance).toFixed(1));
		const speed = this.clampImportedNumber(imported.speed, maxSpeed, 1, PLANAR_SPEED_HARD_MAX, '全局航线速度', warnings);
		return { heightType, lineHeight, speed, takeoffSpeed, overlapW, overlapH, lineAngle, photoTriggerMode, smartObliqueGimbalPitch, photoDistance, maxSpeed };
	}

	/**
	 * 限制单个导入数值，并记录被调整的字段。
	 */
	private clampImportedNumber(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string, warnings: string[]): number {
		if (value === undefined || !Number.isFinite(value)) {
			return fallback;
		}
		const clamped = Math.min(maximum, Math.max(minimum, value));
		if (clamped !== value) {
			warnings.push(`${label}超出页面范围，已调整为 ${clamped}`);
		}
		return clamped;
	}

	/**
	 * 在清理旧状态前解析实际航点高度和拍摄航段。
	 */
	private async prepareImportedRoutes(imported: PlanarKmzImportResult, warnings: string[]): Promise<PreparedImportedRoute[]> {
		const prepared: PreparedImportedRoute[] = [];
		for (let routeIndex = 0; routeIndex < imported.routes.length; routeIndex++) {
			const route = imported.routes[routeIndex];
			const positions = await this.resolveImportedWaypointPositions(route, imported.takeoffPosition, warnings);
			const exportSegments = this.createImportedRouteSegments(route, positions);
			if (exportSegments.length === 0) {
				throw new Error(`第 ${routeIndex + 1} 组航线缺少有效航段`);
			}
			prepared.push({ route, exportSegments });
		}
		return prepared;
	}

	/**
	 * 按执行高度模式将导入航点转换为 Cesium 世界坐标。
	 */
	private async resolveImportedWaypointPositions(
		route: PlanarKmzImportedRoute,
		takeoffPosition: PlanarKmzCoordinate | undefined,
		warnings: string[],
	): Promise<Cesium.Cartesian3[]> {
		const cartographics: Cesium.Cartographic[] = [];
		for (let index = 0; index < route.waypoints.length; index++) {
			const waypoint = route.waypoints[index];
			cartographics.push(Cesium.Cartographic.fromDegrees(waypoint.longitude, waypoint.latitude));
		}

		let terrainHeights: number[] = [];
		const needsTerrain = route.heightMode === 'realTimeFollowSurface' || (route.heightMode === 'relativeToStartPoint' && !takeoffPosition);
		if (needsTerrain) {
			try {
				terrainHeights = await sampleTerrainHeightsAtPositions(window.mainViewer, cartographics);
			} catch {
				for (let index = 0; index < cartographics.length; index++) {
					terrainHeights.push(window.mainViewer.scene.globe.getHeight(cartographics[index]) ?? 0);
				}
				warnings.push('地形服务未返回完整高度，部分导入航点使用当前地图地表高度');
			}
		}

		const positions: Cesium.Cartesian3[] = [];
		for (let index = 0; index < route.waypoints.length; index++) {
			const waypoint = route.waypoints[index];
			let height = waypoint.height;
			if (route.heightMode === 'relativeToStartPoint' && takeoffPosition) {
				height = takeoffPosition.height + waypoint.height;
			} else if (needsTerrain) {
				const terrainHeight = terrainHeights[index] ?? 0;
				height = terrainHeight + waypoint.height;
			}
			positions.push(Cesium.Cartesian3.fromDegrees(waypoint.longitude, waypoint.latitude, height));
		}
		return positions;
	}

	/**
	 * 按当前地图地形重新放置导入测区顶点。
	 */
	private async resolveImportedPolygonPositions(polygon: PlanarKmzCoordinate[], warnings: string[]): Promise<Cesium.Cartesian3[]> {
		const cartographics: Cesium.Cartographic[] = [];
		for (let index = 0; index < polygon.length; index++) {
			cartographics.push(Cesium.Cartographic.fromDegrees(polygon[index].longitude, polygon[index].latitude));
		}

		let terrainHeights: number[] = [];
		this.importedPolygonNeedsSafeView = false;
		try {
			terrainHeights = await sampleTerrainHeightsAtPositions(window.mainViewer, cartographics);
		} catch {
			this.importedPolygonNeedsSafeView = true;
			for (let index = 0; index < cartographics.length; index++) {
				terrainHeights.push(window.mainViewer.scene.globe.getHeight(cartographics[index]) ?? 0);
			}
			warnings.push('当前地形服务未返回完整高度，测区控制点使用已缓存地表高度');
		}

		const positions: Cesium.Cartesian3[] = [];
		for (let index = 0; index < polygon.length; index++) {
			const cartographic = cartographics[index];
			const height = terrainHeights[index] ?? 0;
			positions.push(Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, height));
		}
		return positions;
	}

	/**
	 * 根据拍照动作范围拆分拍摄航段和转场航段。
	 */
	private createImportedRouteSegments(route: PlanarKmzImportedRoute, positions: Cesium.Cartesian3[]): CartesianRouteSegment[] {
		if (positions.length < 2) {
			return [];
		}
		if (route.captureRanges.length === 0) {
			return [{ type: 'scan', positions, captureGroupId: 1 }];
		}

		const ranges = [...route.captureRanges];
		ranges.sort((left, right) => left.startIndex - right.startIndex);
		const segments: CartesianRouteSegment[] = [];
		let currentIndex = 0;
		let scanSegmentCount = 0;
		for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex++) {
			const startIndex = Math.min(positions.length - 1, Math.max(currentIndex, ranges[rangeIndex].startIndex));
			const endIndex = Math.min(positions.length - 1, Math.max(startIndex, ranges[rangeIndex].endIndex));
			if (startIndex > currentIndex) {
				segments.push({ type: 'transit', positions: positions.slice(currentIndex, startIndex + 1) });
			}
			if (endIndex > startIndex) {
				segments.push({ type: 'scan', positions: positions.slice(startIndex, endIndex + 1), captureGroupId: ranges[rangeIndex].id });
				scanSegmentCount++;
			}
			currentIndex = Math.max(currentIndex, endIndex);
		}
		if (currentIndex < positions.length - 1) {
			segments.push({ type: 'transit', positions: positions.slice(currentIndex) });
		}
		return scanSegmentCount > 0 ? segments : [{ type: 'scan', positions, captureGroupId: 1 }];
	}

	/**
	 * 将准备好的导入数据一次性写入地图和页面状态。
	 */
	private applyImportedRoute(imported: PlanarKmzImportResult, config: ImportedConfigValues, preparedRoutes: PreparedImportedRoute[], polygonPositions: Cesium.Cartesian3[]): void {
		this.ctx.clearCurrentRouteState(false);
		globeConfig.climbType = imported.templateType === 'mapping3d' ? 2 : 1;
		globeConfig.heightType = config.heightType;
		globeConfig.lineHeight = config.lineHeight;
		globeConfig.speed = config.speed;
		globeConfig.maxSpeed = config.maxSpeed;
		globeConfig.takeoffSpeed = config.takeoffSpeed;
		globeConfig.overlapW = config.overlapW;
		globeConfig.overlapH = config.overlapH;
		globeConfig.lineAngle = config.lineAngle;
		globeConfig.photoTriggerMode = config.photoTriggerMode;
		globeConfig.smartObliqueGimbalPitch = config.smartObliqueGimbalPitch;
		globeConfig.smartObliqueEnable = imported.smartObliqueEnable === true;
		if (imported.smartObliqueSwingAngle !== undefined) {
			globeConfig.smartObliqueSwingAngle = imported.smartObliqueSwingAngle;
		}
		if (imported.smartObliqueEnable && !getSelectedAircraft().supportsSmartOblique) {
			ElMessage.warning('当前机型不支持智能摆拍');
		}

		const polygonObj = drawImportedPolygon(window.mainViewer, polygonPositions);
		this.ctx.setEntityObjPolygonObj(polygonObj);
		this.ctx.setupPolygonSubscriber();
		this.ctx.enablePolygonRightClick();

		if (imported.takeoffPosition) {
			const takeoff = imported.takeoffPosition;
			const takeoffCartesian = Cesium.Cartesian3.fromDegrees(takeoff.longitude, takeoff.latitude, takeoff.height);
			globeConfig.flyPosition = takeoffCartesian;
			globeConfig.isSetTakeoffPoint = true;
			drawFlyStartLine(window.mainViewer, takeoffCartesian);
		}

		const plannedRoutes: PlannedRouteData[] = [];
		for (let routeIndex = 0; routeIndex < preparedRoutes.length; routeIndex++) {
			const prepared = preparedRoutes[routeIndex];
			// 圆角仅用于地图预览；导出仍用导入原始折线航点
			const previewSegments = this.createRoundedPreviewFromCartesian(prepared.exportSegments);
			const exportConnection = this.ctx.connectTakeoffToFirstWaypoint(prepared.exportSegments);
			const previewConnection = this.ctx.connectTakeoffToFirstWaypoint(previewSegments);
			const missionLength = this.calculateCartesianRouteLength(prepared.exportSegments);
			const approachLength = Math.max(0, this.calculateCartesianRouteLength(exportConnection.segments) - missionLength);
			plannedRoutes.push({
				id: routeIndex + 1,
				key: this.getImportedRouteKey(routeIndex),
				label: String(routeIndex + 1),
				headingDegrees: prepared.route.headingDegrees,
				gimbalPitchDegrees: prepared.route.gimbalPitchDegrees,
				segments: previewConnection.segments,
				exportSegments: prepared.exportSegments,
				coordinates: this.ctx.flattenRouteCoordinates(previewConnection.segments),
				totalLength: missionLength,
				climbLength: approachLength,
				photoCount: this.ctx.calculateRoutePhotoCount(prepared.exportSegments, config.photoDistance, true),
			});
		}

		this.ctx.setIsLineAngleManual(imported.lineAngle !== undefined);
		this.ctx.applyPlannedRoutes(plannedRoutes, config.photoDistance);
		this.scheduleImportedTerrainCorrection(this.importedPolygonNeedsSafeView);
		this.fitImportedRouteView(this.importedPolygonNeedsSafeView);
	}

	/**
	 * 将导入的三维折线航段转为局部平面后做协调转弯圆角，仅用于地图预览。
	 */
	private createRoundedPreviewFromCartesian(exportSegments: CartesianRouteSegment[]): CartesianRouteSegment[] {
		const allPositions: Cesium.Cartesian3[] = [];
		for (let segmentIndex = 0; segmentIndex < exportSegments.length; segmentIndex++) {
			const positions = exportSegments[segmentIndex].positions;
			for (let pointIndex = 0; pointIndex < positions.length; pointIndex++) {
				allPositions.push(positions[pointIndex]);
			}
		}
		if (allPositions.length < 3) {
			return exportSegments;
		}

		let frame: LocalCoordinateFrame;
		try {
			frame = createLocalCoordinateFrame(allPositions);
		} catch {
			return exportSegments;
		}

		const localSegments: PlanarRouteSegment[] = [];
		const segmentHeights: number[][] = [];
		for (let segmentIndex = 0; segmentIndex < exportSegments.length; segmentIndex++) {
			const segment = exportSegments[segmentIndex];
			const points: LocalPoint[] = [];
			const heights: number[] = [];
			for (let pointIndex = 0; pointIndex < segment.positions.length; pointIndex++) {
				points.push(frame.toLocal(segment.positions[pointIndex]));
				const cartographic = Cesium.Cartographic.fromCartesian(segment.positions[pointIndex]);
				heights.push(cartographic ? cartographic.height : 0);
			}
			localSegments.push({ type: segment.type, points, captureGroupId: segment.captureGroupId });
			segmentHeights.push(heights);
		}

		let roundedLocalSegments: PlanarRouteSegment[];
		try {
			roundedLocalSegments = roundPlanarRouteSegments(localSegments);
		} catch {
			return exportSegments;
		}

		const result: CartesianRouteSegment[] = [];
		for (let segmentIndex = 0; segmentIndex < roundedLocalSegments.length; segmentIndex++) {
			const localSegment = roundedLocalSegments[segmentIndex];
			const positions: Cesium.Cartesian3[] = [];
			for (let pointIndex = 0; pointIndex < localSegment.points.length; pointIndex++) {
				const localPoint = localSegment.points[pointIndex];
				const height = this.interpolateHeightOnLocalRoute(localPoint, localSegments, segmentHeights);
				positions.push(frame.toCartesian(localPoint, height));
			}
			if (positions.length >= 2) {
				result.push({ type: localSegment.type, positions, captureGroupId: localSegment.captureGroupId });
			}
		}
		return result.length > 0 ? result : exportSegments;
	}

	/**
	 * 将圆角预览点投影回原始局部航段，线性插值航点高度。
	 */
	private interpolateHeightOnLocalRoute(point: LocalPoint, localSegments: PlanarRouteSegment[], segmentHeights: number[][]): number {
		let bestDistanceSquared = Number.POSITIVE_INFINITY;
		let bestHeight = 0;
		for (let segmentIndex = 0; segmentIndex < localSegments.length; segmentIndex++) {
			const points = localSegments[segmentIndex].points;
			const heights = segmentHeights[segmentIndex];
			for (let pointIndex = 0; pointIndex + 1 < points.length; pointIndex++) {
				const start = points[pointIndex];
				const end = points[pointIndex + 1];
				const dx = end.x - start.x;
				const dy = end.y - start.y;
				const lengthSquared = dx * dx + dy * dy;
				let ratio = 0;
				if (lengthSquared > 1e-14) {
					ratio = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
					ratio = Math.min(1, Math.max(0, ratio));
				}
				const projX = start.x + dx * ratio;
				const projY = start.y + dy * ratio;
				const distanceSquared = (point.x - projX) * (point.x - projX) + (point.y - projY) * (point.y - projY);
				if (distanceSquared < bestDistanceSquared) {
					bestDistanceSquared = distanceSquared;
					bestHeight = heights[pointIndex] + (heights[pointIndex + 1] - heights[pointIndex]) * ratio;
				}
			}
		}
		return bestHeight;
	}

	/**
	 * 将导入航线序号映射到现有五向航线键。
	 */
	private getImportedRouteKey(index: number): FiveDirectionRouteKey {
		const keys: FiveDirectionRouteKey[] = ['nadir', 'direction1', 'direction2', 'direction3', 'direction4'];
		return keys[index] ?? 'nadir';
	}

	/**
	 * 根据测区和全部实际航段自适应导入视角。
	 */
	private fitImportedRouteView(useSafeAbsoluteHeight: boolean): void {
		const positions: Cesium.Cartesian3[] = [];
		const polygonPositions = this.ctx.entityObjPolygonObj?.polygonPositions ?? [];
		for (let index = 0; index < polygonPositions.length; index++) {
			positions.push(polygonPositions[index]);
		}
		if (positions.length === 0) {
			return;
		}

		const boundingSphere = Cesium.BoundingSphere.fromPoints(positions);
		let range = Math.max(IMPORT_VIEW_MINIMUM_RANGE, boundingSphere.radius * 3);
		if (useSafeAbsoluteHeight) {
			const centerCartographic = Cesium.Cartographic.fromCartesian(boundingSphere.center);
			range = Math.max(range, IMPORT_VIEW_SAFE_ABSOLUTE_HEIGHT - centerCartographic.height);
		}
		window.mainViewer.camera.viewBoundingSphere(boundingSphere, new Cesium.HeadingPitchRange(0, Cesium.Math.toRadians(-90), range));
		window.mainViewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
		window.mainViewer.scene.requestRender();
	}

	/**
	 * 等待导入区域地形瓦片加载完成后执行一次控制点高程修正。
	 */
	private scheduleImportedTerrainCorrection(refitAfterCorrection: boolean): void {
		this.cancelImportedTerrainCorrection();
		let hasPendingTiles = false;
		const finishCorrection = () => {
			this.cancelImportedTerrainCorrection();
			void this.correctImportedPolygonTerrain(refitAfterCorrection);
		};
		this.importedTerrainLoadCleanup = window.mainViewer.scene.globe.tileLoadProgressEvent.addEventListener((pendingTiles: number) => {
			if (pendingTiles > 0) {
				hasPendingTiles = true;
				return;
			}
			if (hasPendingTiles) {
				finishCorrection();
			}
		});
		this.importedTerrainIdleTimer = setTimeout(() => {
			if (!hasPendingTiles) {
				finishCorrection();
			}
		}, IMPORT_TERRAIN_IDLE_DELAY);
	}

	/**
	 * 使用已加载的 Cesium 地形瓦片修正导入测区控制点并重新取景。
	 */
	private async correctImportedPolygonTerrain(refitAfterCorrection: boolean): Promise<void> {
		const polygonState = this.ctx.entityObjPolygonObj;
		if (!polygonState || polygonState.polygonPositions.length < 3) {
			return;
		}
		const cartographics: Cesium.Cartographic[] = [];
		for (let index = 0; index < polygonState.polygonPositions.length; index++) {
			const cartographic = Cesium.Cartographic.fromCartesian(polygonState.polygonPositions[index]);
			cartographics.push(cartographic);
		}

		const renderedHeights: Array<number | undefined> = [];
		for (let index = 0; index < cartographics.length; index++) {
			renderedHeights.push(window.mainViewer.scene.globe.getHeight(cartographics[index]));
		}
		let sampledHeights: number[] = [];
		if (refitAfterCorrection || renderedHeights.some((height) => !Number.isFinite(height))) {
			try {
				sampledHeights = await sampleTerrainHeightsAtPositions(window.mainViewer, cartographics);
			} catch {
				sampledHeights = [];
			}
		}
		if (this.ctx.entityObjPolygonObj !== polygonState) {
			return;
		}

		let correctedPointCount = 0;
		for (let index = 0; index < cartographics.length; index++) {
			const renderedHeight = renderedHeights[index];
			const height = refitAfterCorrection || !Number.isFinite(renderedHeight) ? sampledHeights[index] : renderedHeight;
			if (typeof height !== 'number' || !Number.isFinite(height)) {
				continue;
			}
			const cartographic = cartographics[index];
			const correctedPosition = Cesium.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, height);
			polygonState.polygonPositions[index] = correctedPosition;
			polygonState.pointEntityList[index].position = new Cesium.ConstantPositionProperty(correctedPosition);
			correctedPointCount++;
		}
		if (correctedPointCount === 0) {
			return;
		}

		globeConfig.polygonPositions = polygonState.polygonPositions;
		if (refitAfterCorrection) {
			this.scheduleImportedTerrainCorrection(false);
			this.fitImportedRouteView(false);
		}
		window.mainViewer.scene.requestRender();
	}

	/**
	 * 计算 Cartesian3 航段数组的总长度。
	 */
	private calculateCartesianRouteLength(segments: CartesianRouteSegment[]): number {
		let total = 0;
		for (let i = 0; i < segments.length; i++) {
			const positions = segments[i].positions;
			for (let j = 0; j + 1 < positions.length; j++) {
				total += Cesium.Cartesian3.distance(positions[j], positions[j + 1]);
			}
		}
		return total;
	}
}
