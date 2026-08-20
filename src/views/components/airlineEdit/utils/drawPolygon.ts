import * as Cesium from 'cesium';
import globeConfig from '../config/planarConfig';
import { calculateArea } from './planarLine';
import * as turf from '@turf/turf';
import { ElMessage } from 'element-plus';

export interface PolygonDrawingResult {
	polygonEntity: Cesium.Entity;
	lineEntity: Cesium.Entity;
	pointLast: Cesium.Entity;
	lineLast: Cesium.Entity;
	polygonPositions: Cesium.Cartesian3[];
	pointEntityList: Cesium.Entity[];
	entityLabelList: Cesium.Entity[];
	holes?: Cesium.Cartesian3[][];
	holeLineEntityList?: Cesium.Entity[];
	holePointEntityList?: Cesium.Entity[][];
	pointTndex?: number;
	pointHoleIndex?: number;
}

/** 测区多边形填充透明度（0~1），修改此处即可全局生效 */
const POLYGON_FILL_ALPHA = 0.3;
/** 测区自相交警告时填充透明度 */
const POLYGON_KINKS_FILL_ALPHA = 0.2;
/** 挖孔轮廓线颜色 */
const HOLE_LINE_COLOR = Cesium.Color.ORANGE;
/** 挖孔顶点颜色 */
const HOLE_POINT_COLOR = Cesium.Color.ORANGE;
/** 挖孔预览填充颜色 */
const HOLE_PREVIEW_FILL = Cesium.Color.RED.withAlpha(0.2);

/**
 * 创建测区多边形填充材质。
 */
function createPolygonFillMaterial(alpha: number = POLYGON_FILL_ALPHA): Cesium.Color {
	return Cesium.Color.DODGERBLUE.withAlpha(alpha);
}

/** 图形自相交数量 */
let isKinks = false;

/** 多边形点位 */
let polygonPositions: any = [];

/** 挖孔环点位（与 polygonPositions 同步，用于自相交检测） */
let polygonHoles: any = [];

let entity: any = null;

let drawDataSource: any = null;

/**
 * 根据外环与挖孔环构造 Cesium 多边形层级。
 */
function buildPolygonHierarchy(positions: Cesium.Cartesian3[], holes?: Cesium.Cartesian3[][]): Cesium.PolygonHierarchy {
	const holeHierarchies: Cesium.PolygonHierarchy[] = [];
	const holeList = holes ?? [];
	for (let index = 0; index < holeList.length; index++) {
		if (holeList[index] && holeList[index].length >= 3) {
			holeHierarchies.push(new Cesium.PolygonHierarchy(holeList[index]));
		}
	}
	return new Cesium.PolygonHierarchy(positions, holeHierarchies);
}

//此函数用来绘制多边形
export function drawPolygon(viewer, callback, cancelCallback: () => void): () => void {
	drawDataSource = window.mainViewer.dataSources.getByName('drawDataSource').at(-1);
	const mapContainer = document.querySelector<HTMLElement>('.wayMap');
	if (mapContainer) {
		// 设置自定义光标样式
		mapContainer.style.cursor = 'crosshair';
	} else {
		console.warn('未找到地图容器');
	}
	// 外部复用地图时悬停在 canvas 上，需同步十字光标
	viewer.canvas.style.cursor = 'crosshair';
	// callback('123')
	// console.log('用来控制多边形的绘制')
	let handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
	let handler2 = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
	polygonPositions = [];
	polygonHoles = [];
	resetKinksState();
	let polygonEntity = null;
	let lineEntity = null;
	let index = -1;
	let pointEntityList: any = [];
	let entityLabelist: any = [];

	/** 销毁本轮未完成绘制使用的事件监听。 */
	const cleanupDrawing = (): void => {
		document.removeEventListener('keydown', handleKeyDown);
		if (!handler.isDestroyed()) {
			handler.destroy();
		}
		if (!handler2.isDestroyed()) {
			handler2.destroy();
		}
		if (mapContainer) {
			mapContainer.style.cursor = 'default';
		}
		viewer.canvas.style.cursor = 'default';
	};

	/** 按 Esc 放弃未完成测区并立即重新进入绘制。 */
	const handleKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape') {
			return;
		}
		event.preventDefault();
		cleanupDrawing();
		cancelCallback();
	};

	document.addEventListener('keydown', handleKeyDown);
	handler.setInputAction((click) => {
		/**点击位置笛卡尔坐标 */
		let cartesian = pickTerrainPosition(viewer, click.position);
		if (!cartesian) {
			return;
		}
		// return
		let cartographic = Cesium.Cartographic.fromCartesian(cartesian);
		let lng = Cesium.Math.toDegrees(cartographic.longitude);
		let lat = Cesium.Math.toDegrees(cartographic.latitude);
		console.log(lng, '查看当前点击的经纬度信息', lat);
		polygonPositions.push(cartesian);
		console.log(polygonPositions, '查看当前点击的经纬度信息123');
		index++;
		let pointEntity = drawDataSource.entities.add({
			name: `polygonPoint`,
			position: new Cesium.CallbackProperty(function () {
				return Cesium.Cartesian3.fromDegrees(lng, lat);
			}, false),
			point: {
				pixelSize: 8.0,
				color: Cesium.Color.WHITE.withAlpha(0.8),
				outlineWidth: 1,
				outlineColor: Cesium.Color.WHITE,
				heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			customData: index,
		});
		pointEntityList.push(pointEntity);

		entityLabelist.push(
			drawDataSource.entities.add({
				position: cartesian,
				label: {
					text: '0', // 显示的文本
					font: '14px sans-serif', // 字体
					fillColor: Cesium.Color.WHITE, // 字体颜色
					outlineWidth: 2, // 字体轮廓宽度
					clampToGround: true,
					showBackground: true,
					backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
					heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
					horizontalOrigin: Cesium.HorizontalOrigin.CENTER, // 水平对齐
					verticalOrigin: Cesium.VerticalOrigin.CENTER, // 垂直对齐
					pixelOffset: new Cesium.Cartesian2(0, -20), // 向上偏移10像素
				},
				customData: Date.now(),
			}),
		);
		// console.log(entityLabel,'查看当前label的信息1')

		handler2.setInputAction((event) => {
			const currentPosition = pickTerrainPosition(viewer, event.endPosition);
			if (!currentPosition) {
				return;
			}
			if (polygonPositions.length === 1) {
				polygonPositions.push(currentPosition);
			}
			if (polygonPositions.length >= 2) {
				if (lineEntity === null) {
					lineEntity = drawDataSource.entities.add({
						name: 'polygonLine',
						polyline: {
							positions: new Cesium.CallbackProperty(function () {
								return polygonPositions;
							}, false),
							material: Cesium.Color.DODGERBLUE,
							width: 5, // 设置线段宽度
							clampToGround: true,
						},
						ringIndex: -1,
					});
				}
				polygonPositions[polygonPositions.length - 1] = currentPosition;
			}

			// 获取当前鼠标移动对应的左键点击点坐标
			let clickIndex = polygonPositions.length - 2;
			let clickPointForLabel = polygonPositions[clickIndex];

			updateDistanceLabel(entityLabelist[clickIndex], clickPointForLabel, currentPosition);

			if (polygonPositions.length > 2) {
				iskinksBoolean();
				upEntityColor(polygonEntity, lineEntity);
			}
		}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

		// //绘制多边形
		if (polygonPositions.length >= 3) {
			if (polygonEntity === null) {
				polygonEntity = drawDataSource.entities.add({
					name: `polygon`,
					polygon: {
						hierarchy: new Cesium.CallbackProperty(function () {
							return new Cesium.PolygonHierarchy(polygonPositions);
						}, false),
						material: createPolygonFillMaterial(),
						outline: POLYGON_FILL_ALPHA > 0,
						outlineColor: Cesium.Color.BLACK,
						outlineWidth: 12,
					},
				});
			}
		}
	}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

	//鼠标右击事件结束
	handler.setInputAction((click) => {
		if (polygonPositions.length < 3) {
			return;
		}
		// 恢复鼠标样式
		if (mapContainer) {
			mapContainer.style.cursor = 'default';
		}
		viewer.canvas.style.cursor = 'default';
		let cartesian = pickTerrainPosition(viewer, click.position);
		if (!cartesian) {
			return;
		}
		polygonPositions[polygonPositions.length - 1] = cartesian;
		const previousEdgeIndex = polygonPositions.length - 2;
		updateDistanceLabel(entityLabelist[previousEdgeIndex], polygonPositions[previousEdgeIndex], cartesian);
		iskinksBoolean();
		upEntityColor(polygonEntity, lineEntity);
		if (isKinks) {
			return;
		}
		let cartographic = Cesium.Cartographic.fromCartesian(cartesian);
		let lng = Cesium.Math.toDegrees(cartographic.longitude);
		let lat = Cesium.Math.toDegrees(cartographic.latitude);
		let pointLast = drawDataSource.entities.add({
			name: `polygonPoint`,
			position: new Cesium.CallbackProperty(function () {
				return Cesium.Cartesian3.fromDegrees(lng, lat);
			}, false),
			point: {
				pixelSize: 8.0,
				color: Cesium.Color.WHITE,
				outlineWidth: 1,
				outlineColor: Cesium.Color.WHITE,
				heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			customData: index + 1,
		});
		pointEntityList.push(pointLast);
		let lineLast = drawDataSource.entities.add({
			name: 'polygonLine',
			polyline: {
				positions: new Cesium.CallbackProperty(function () {
					return [polygonPositions[polygonPositions.length - 1], polygonPositions[0]];
				}, false),
				material: Cesium.Color.DODGERBLUE,
				width: 5, // 设置线段宽度
				clampToGround: true,
			},
			ringIndex: -1,
		});
		const closingMetrics = calculateEdgeMetrics(polygonPositions[polygonPositions.length - 1], polygonPositions[0]);
		entityLabelist.push(
			drawDataSource.entities.add({
				position: closingMetrics.middlePosition,
				label: {
					text: `${closingMetrics.distance.toFixed(2)}米`, // 显示的文本
					font: '16px sans-serif', // 字体
					fillColor: Cesium.Color.WHITE, // 字体颜色
					clampToGround: true,
					showBackground: true,
					backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
					heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
					horizontalOrigin: Cesium.HorizontalOrigin.CENTER, // 水平对齐
					verticalOrigin: Cesium.VerticalOrigin.CENTER, // 垂直对齐
					pixelOffset: new Cesium.Cartesian2(0, -20), // 向上偏移10像素
				},
				customData: Date.now(),
			}),
		);
		cleanupDrawing();
		let params = {
			polygonEntity: polygonEntity,
			lineEntity: lineEntity,
			pointLast: pointLast,
			lineLast: lineLast,
			polygonPositions: polygonPositions,
			pointEntityList: pointEntityList,
			entityLabelList: entityLabelist,
			holes: [] as Cesium.Cartesian3[][],
			holeLineEntityList: [] as Cesium.Entity[],
			holePointEntityList: [] as Cesium.Entity[][],
		};

		globeConfig.polygonPositions = polygonPositions;

		globeConfig.area = Number(calculateArea(params.polygonPositions).toFixed(2));

		callback(params);
	}, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

	return cleanupDrawing;
}

/**
 * 使用导入坐标恢复可继续拖拽编辑的测区实体。
 */
export function drawImportedPolygon(viewer: Cesium.Viewer, importedPositions: Cesium.Cartesian3[]): PolygonDrawingResult {
	if (importedPositions.length < 3) {
		throw new Error('导入测区至少需要三个顶点');
	}
	const drawSources = viewer.dataSources.getByName('drawDataSource');
	const dataSource = drawSources.at(-1);
	if (!(dataSource instanceof Cesium.CustomDataSource)) {
		throw new Error('测区数据源尚未初始化');
	}

	polygonPositions = [];
	for (let index = 0; index < importedPositions.length; index++) {
		polygonPositions.push(Cesium.Cartesian3.clone(importedPositions[index]));
	}
	polygonHoles = [];
	resetKinksState();

	const polygonEntity = dataSource.entities.add({
		name: 'polygon',
		polygon: {
			hierarchy: new Cesium.CallbackProperty(() => new Cesium.PolygonHierarchy(polygonPositions), false),
			material: createPolygonFillMaterial(),
			outline: POLYGON_FILL_ALPHA > 0,
			outlineColor: Cesium.Color.BLACK,
			outlineWidth: 12,
			heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
			perPositionHeight: false,
		},
	});
	const lineEntity = dataSource.entities.add({
		name: 'polygonLine',
		polyline: {
			positions: new Cesium.CallbackProperty(() => polygonPositions, false),
			material: Cesium.Color.DODGERBLUE,
			width: 5,
			clampToGround: true,
		},
	}) as Cesium.Entity & { ringIndex?: number };
	lineEntity.ringIndex = -1;
	const lineLast = dataSource.entities.add({
		name: 'polygonLine',
		polyline: {
			positions: new Cesium.CallbackProperty(() => [polygonPositions[polygonPositions.length - 1], polygonPositions[0]], false),
			material: Cesium.Color.DODGERBLUE,
			width: 5,
			clampToGround: true,
		},
	}) as Cesium.Entity & { ringIndex?: number };
	lineLast.ringIndex = -1;

	const pointEntityList: Cesium.Entity[] = [];
	const entityLabelList: Cesium.Entity[] = [];
	for (let index = 0; index < polygonPositions.length; index++) {
		const position = polygonPositions[index];
		const pointEntity = dataSource.entities.add({
			name: 'polygonPoint',
			position,
			point: {
				pixelSize: 8,
				color: Cesium.Color.WHITE.withAlpha(0.8),
				outlineWidth: 1,
				outlineColor: Cesium.Color.WHITE,
				heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
		});
		const editablePoint = pointEntity as Cesium.Entity & { customData?: number };
		editablePoint.customData = index;
		pointEntityList.push(pointEntity);

		const nextIndex = (index + 1) % polygonPositions.length;
		const metrics = calculateEdgeMetrics(position, polygonPositions[nextIndex]);
		entityLabelList.push(
			dataSource.entities.add({
				position: metrics.middlePosition,
				label: {
					text: `${metrics.distance.toFixed(2)}米`,
					font: '16px sans-serif',
					fillColor: Cesium.Color.WHITE,
					outlineWidth: 2,
					showBackground: true,
					backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
					heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
					horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
					verticalOrigin: Cesium.VerticalOrigin.CENTER,
					pixelOffset: new Cesium.Cartesian2(0, -20),
				},
			}),
		);
	}

	globeConfig.polygonPositions = polygonPositions;
	globeConfig.area = Number(calculateArea(polygonPositions).toFixed(2));
	viewer.scene.requestRender();
	return {
		polygonEntity,
		lineEntity,
		pointLast: pointEntityList[pointEntityList.length - 1],
		lineLast,
		polygonPositions,
		pointEntityList,
		entityLabelList,
		holes: [],
		holeLineEntityList: [],
		holePointEntityList: [],
	};
}

/** 进行中的顶点拖动事件处理器 */
let movePolygonHandler: Cesium.ScreenSpaceEventHandler | null = null;
/** 进行中拖动的结束函数 */
let movePolygonEndDrag: (() => void) | null = null;

/**
 * 中止进行中的顶点拖动编辑（挖孔等新模式启动前调用，避免事件冲突）。
 */
export function cancelMovePolygon(): void {
	if (movePolygonEndDrag) {
		const endDrag = movePolygonEndDrag;
		movePolygonEndDrag = null;
		endDrag();
	}
	if (movePolygonHandler) {
		if (!movePolygonHandler.isDestroyed()) {
			movePolygonHandler.destroy();
		}
		movePolygonHandler = null;
	}
	restoreCameraDrag();
}

/** 顶点拖动期间禁用相机左键拖动，避免拖点时地图跟着移动。 */
function disableCameraDrag(): void {
	const viewer = window.mainViewer;
	if (!viewer) {
		return;
	}
	viewer.scene.screenSpaceCameraController.enableRotate = false;
	viewer.scene.screenSpaceCameraController.enableTranslate = false;
}

/** 恢复相机拖动。 */
function restoreCameraDrag(): void {
	const viewer = window.mainViewer;
	if (!viewer) {
		return;
	}
	viewer.scene.screenSpaceCameraController.enableRotate = true;
	viewer.scene.screenSpaceCameraController.enableTranslate = true;
}

/**
 * 顶点编辑统一入口：按下顶点直接拖动；按下边线在该边插入新顶点并拖动。
 * 按住拖动，左键放开完成本次编辑。
 */
export function beginVertexEdit(
	entityObjPolygonObj: PolygonDrawingResult,
	viewer: Cesium.Viewer,
	pickedEntity: Cesium.Entity & { customData?: number; ringIndex?: number },
	windowPosition: Cesium.Cartesian2,
	callback: (value: PolygonDrawingResult) => void,
): void {
	drawDataSource = window.mainViewer.dataSources.getByName('drawDataSource').at(-1);

	if (pickedEntity.name === 'polygonPoint' && pickedEntity.customData !== undefined) {
		entityObjPolygonObj.pointTndex = pickedEntity.customData;
		entityObjPolygonObj.pointHoleIndex = pickedEntity.ringIndex !== undefined ? pickedEntity.ringIndex : -1;
		movePolygon(entityObjPolygonObj, viewer, callback);
		return;
	}

	if (pickedEntity.name === 'polygonLine') {
		const clickCartesian = pickTerrainPosition(viewer, windowPosition);
		if (!clickCartesian) {
			return;
		}
		const ringIndex = pickedEntity.ringIndex !== undefined ? pickedEntity.ringIndex : -1;
		const insertIndex = insertVertexOnLine(entityObjPolygonObj, ringIndex, clickCartesian);
		if (insertIndex < 0) {
			return;
		}
		entityObjPolygonObj.pointTndex = insertIndex;
		entityObjPolygonObj.pointHoleIndex = ringIndex;
		movePolygon(entityObjPolygonObj, viewer, callback);
	}
}

/**
 * 在环的最近边上插入一个顶点（点击边线加点），返回新顶点索引；失败返回 -1。
 */
function insertVertexOnLine(entityObjPolygonObj: PolygonDrawingResult, ringIndex: number, clickCartesian: Cesium.Cartesian3): number {
	const rings = ringIndex >= 0 ? entityObjPolygonObj.holes ?? [] : [entityObjPolygonObj.polygonPositions];
	const ring = rings[ringIndex >= 0 ? ringIndex : 0];
	if (!ring || ring.length < 3) {
		return -1;
	}

	let bestEdgeIndex = -1;
	let bestPoint: Cesium.Cartesian3 | null = null;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let index = 0; index < ring.length; index++) {
		const nextIndex = (index + 1) % ring.length;
		const projected = projectPointToSegment(clickCartesian, ring[index], ring[nextIndex]);
		const distance = Cesium.Cartesian3.distance(clickCartesian, projected);
		if (distance < bestDistance) {
			bestDistance = distance;
			bestEdgeIndex = index;
			bestPoint = projected;
		}
	}
	if (bestEdgeIndex < 0 || !bestPoint) {
		return -1;
	}

	const insertIndex = bestEdgeIndex + 1;
	ring.splice(insertIndex, 0, bestPoint);

	if (ringIndex >= 0) {
		rebuildHoleRingEntities(entityObjPolygonObj, ringIndex);
	} else {
		rebuildOuterRingEntities(entityObjPolygonObj);
	}

	return insertIndex;
}

/**
 * 计算点到线段的最近点（3D 投影）。
 */
function projectPointToSegment(point: Cesium.Cartesian3, start: Cesium.Cartesian3, end: Cesium.Cartesian3): Cesium.Cartesian3 {
	const direction = Cesium.Cartesian3.subtract(end, start, new Cesium.Cartesian3());
	const offset = Cesium.Cartesian3.subtract(point, start, new Cesium.Cartesian3());
	const squaredLength = Cesium.Cartesian3.magnitudeSquared(direction);
	if (squaredLength <= 1e-10) {
		return Cesium.Cartesian3.clone(start);
	}
	let ratio = Cesium.Cartesian3.dot(offset, direction) / squaredLength;
	ratio = Math.max(0, Math.min(1, ratio));
	return Cesium.Cartesian3.add(start, Cesium.Cartesian3.multiplyByScalar(direction, ratio, new Cesium.Cartesian3()), new Cesium.Cartesian3());
}

/**
 * 重建外环全部顶点与边标签（加点后索引整体变化，重建最可靠）。
 */
function rebuildOuterRingEntities(entityObjPolygonObj: PolygonDrawingResult): void {
	const pointEntityList = entityObjPolygonObj.pointEntityList ?? [];
	for (let index = 0; index < pointEntityList.length; index++) {
		drawDataSource.entities.remove(pointEntityList[index]);
	}
	const labelList = entityObjPolygonObj.entityLabelList ?? [];
	for (let index = 0; index < labelList.length; index++) {
		drawDataSource.entities.remove(labelList[index]);
	}

	const positions = entityObjPolygonObj.polygonPositions;
	const newPointList: Cesium.Entity[] = [];
	const newLabelList: Cesium.Entity[] = [];
	for (let index = 0; index < positions.length; index++) {
		const pointEntity = drawDataSource.entities.add(createOuterVertexEntity(positions[index], index));
		newPointList.push(pointEntity);

		const nextIndex = (index + 1) % positions.length;
		const metrics = calculateEdgeMetrics(positions[index], positions[nextIndex]);
		newLabelList.push(
			drawDataSource.entities.add({
				position: metrics.middlePosition,
				label: {
					text: `${metrics.distance.toFixed(2)}米`,
					font: '16px sans-serif',
					fillColor: Cesium.Color.WHITE,
					outlineWidth: 2,
					showBackground: true,
					backgroundColor: Cesium.Color.BLACK.withAlpha(0.5),
					heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
					horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
					verticalOrigin: Cesium.VerticalOrigin.CENTER,
					pixelOffset: new Cesium.Cartesian2(0, -20),
				},
			}),
		);
	}
	entityObjPolygonObj.pointEntityList = newPointList;
	entityObjPolygonObj.entityLabelList = newLabelList;
	entityObjPolygonObj.pointLast = newPointList[newPointList.length - 1];
}

/**
 * 创建外环顶点实体。
 */
function createOuterVertexEntity(position: Cesium.Cartesian3, index: number): any {
	return {
		name: 'polygonPoint',
		position,
		point: {
			pixelSize: 8,
			color: Cesium.Color.WHITE.withAlpha(0.8),
			outlineWidth: 1,
			outlineColor: Cesium.Color.WHITE,
			heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
			disableDepthTestDistance: Number.POSITIVE_INFINITY,
		},
		customData: index,
		ringIndex: -1,
	};
}

/**
 * 重建指定挖孔环全部顶点实体。
 */
function rebuildHoleRingEntities(entityObjPolygonObj: PolygonDrawingResult, holeIndex: number): void {
	const holePoints = entityObjPolygonObj.holePointEntityList?.[holeIndex] ?? [];
	for (let index = 0; index < holePoints.length; index++) {
		drawDataSource.entities.remove(holePoints[index]);
	}

	const ring = entityObjPolygonObj.holes![holeIndex];
	const newPointList: Cesium.Entity[] = [];
	for (let index = 0; index < ring.length; index++) {
		newPointList.push(
			drawDataSource.entities.add({
				name: 'polygonPoint',
				position: ring[index],
				point: {
					pixelSize: 7,
					color: HOLE_POINT_COLOR.withAlpha(0.9),
					outlineWidth: 1,
					outlineColor: Cesium.Color.WHITE,
					heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
					disableDepthTestDistance: Number.POSITIVE_INFINITY,
				},
				customData: index,
				ringIndex: holeIndex,
			}),
		);
	}
	entityObjPolygonObj.holePointEntityList![holeIndex] = newPointList;
}

//拖动多边形顶点：按住拖动，松开左键完成
export function movePolygon(entityObjPolygonObj, viewer, callback) {
	entity = entityObjPolygonObj;
	cancelMovePolygon();

	const pointIndex = entityObjPolygonObj.pointTndex;
	const holes: Cesium.Cartesian3[][] = entityObjPolygonObj.holes ?? [];
	const holeIndex = Number.isInteger(entityObjPolygonObj.pointHoleIndex) ? (entityObjPolygonObj.pointHoleIndex as number) : -1;
	const isHolePoint = holeIndex >= 0 && holeIndex < holes.length;
	const ringPositions = isHolePoint ? holes[holeIndex] : entityObjPolygonObj.polygonPositions;
	if (!Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= ringPositions.length) {
		return;
	}

	// 绑定一次实时回调：插点后即使未发生拖动，面与轮廓也会立即更新
	entityObjPolygonObj.polygonEntity.polygon.hierarchy = new Cesium.CallbackProperty(() => {
		return buildPolygonHierarchy(entityObjPolygonObj.polygonPositions, entityObjPolygonObj.holes);
	}, false);
	if (isHolePoint) {
		const holeLineEntity = entityObjPolygonObj.holeLineEntityList?.[holeIndex];
		if (holeLineEntity) {
			holeLineEntity.polyline.positions = new Cesium.CallbackProperty(() => {
				const ring = holes[holeIndex];
				return [...ring, ring[0]];
			}, false);
		}
	} else {
		const pointCount = entityObjPolygonObj.polygonPositions.length;
		entityObjPolygonObj.lineEntity.polyline.positions = new Cesium.CallbackProperty(() => {
			return entityObjPolygonObj.polygonPositions;
		}, false);
		entityObjPolygonObj.lineLast.polyline.positions = new Cesium.CallbackProperty(() => {
			return [entityObjPolygonObj.polygonPositions[pointCount - 1], entityObjPolygonObj.polygonPositions[0]];
		}, false);
	}

	const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
	movePolygonHandler = handler;
	disableCameraDrag();

	let finished = false;
	const endDrag = () => {
		if (finished) {
			return;
		}
		finished = true;
		movePolygonEndDrag = null;
		document.removeEventListener('mouseup', onRelease, true);
		document.removeEventListener('pointerup', onRelease, true);
		document.removeEventListener('pointercancel', endDrag, true);
		window.removeEventListener('blur', endDrag);
		if (!handler.isDestroyed()) {
			handler.destroy();
		}
		if (movePolygonHandler === handler) {
			movePolygonHandler = null;
		}
		restoreCameraDrag();
		if (isKinks) {
			ElMessage.warning('测区不支持交叉面，请继续调整顶点');
		}
		callback(entityObjPolygonObj);
	};

	// 本函数在 mousedown 派发过程中被调用，此时新建的 ScreenSpaceEventHandler
	// 不会记录按钮按下状态（其 LEFT_UP 永远不触发），因此拖动结束
	// 改由 document 级 mouseup/pointerup 兜底。
	const onRelease = (event: Event) => {
		if ('button' in event && (event as MouseEvent).button !== 0) {
			return;
		}
		endDrag();
	};
	movePolygonEndDrag = endDrag;
	document.addEventListener('mouseup', onRelease, true);
	document.addEventListener('pointerup', onRelease, true);
	document.addEventListener('pointercancel', endDrag, true);
	window.addEventListener('blur', endDrag);

	handler.setInputAction((event) => {
		const currentPosition = pickTerrainPosition(viewer, event.endPosition);
		if (!currentPosition) {
			return;
		}

		ringPositions[pointIndex] = currentPosition;

		if (isHolePoint) {
			const holePoints = entityObjPolygonObj.holePointEntityList?.[holeIndex];
			if (holePoints && holePoints[pointIndex]) {
				holePoints[pointIndex].position = new Cesium.CallbackProperty(() => {
					return currentPosition;
				}, false);
			}
		} else {
			const pointCount = entityObjPolygonObj.polygonPositions.length;
			const previousEdgeIndex = (pointIndex - 1 + pointCount) % pointCount;
			updatePolygonEdgeLabel(entityObjPolygonObj, previousEdgeIndex);
			updatePolygonEdgeLabel(entityObjPolygonObj, pointIndex);
			entityObjPolygonObj.pointEntityList[pointIndex].position = new Cesium.CallbackProperty(() => {
				return currentPosition;
			}, false);
		}

		polygonPositions = entityObjPolygonObj.polygonPositions;
		polygonHoles = entityObjPolygonObj.holes ?? [];
		if (polygonPositions.length > 2) {
			iskinksBoolean();
			upEntityColor(entity.polygonEntity, entity.lineEntity, entity.lineLast);
		}
	}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);
}

/**
 * 在已绘制的测区内部绘制挖孔环，完成后写入 entityObjPolygonObj.holes 并触发回调。
 * 左键加点（仅允许落在测区内部且不与其他挖孔重叠），右键完成，Esc 取消。
 */
export function drawHole(entityObjPolygonObj: PolygonDrawingResult, viewer: Cesium.Viewer, callback: (value: PolygonDrawingResult) => void, cancelCallback: () => void): () => void {
	cancelMovePolygon();
	drawDataSource = window.mainViewer.dataSources.getByName('drawDataSource').at(-1);
	const mapContainer = document.querySelector<HTMLElement>('.wayMap');
	if (mapContainer) {
		mapContainer.style.cursor = 'crosshair';
	}
	viewer.canvas.style.cursor = 'crosshair';

	const holePositions: Cesium.Cartesian3[] = [];
	const pointEntityList: Cesium.Entity[] = [];
	let previewLine: Cesium.Entity | null = null;
	let previewPolygon: Cesium.Entity | null = null;
	let handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

	/** 将笛卡尔坐标转为经纬度（度）。 */
	const toDegrees = (position: Cesium.Cartesian3): number[] => {
		const cartographic = Cesium.Cartographic.fromCartesian(position);
		return [Cesium.Math.toDegrees(cartographic.longitude), Cesium.Math.toDegrees(cartographic.latitude)];
	};

	/** 判断点是否位于有效测区内部（外环内且不在任何已有挖孔中）。 */
	const isPositionInsideArea = (position: Cesium.Cartesian3): boolean => {
		const point = toDegrees(position);
		const outerRing = entityObjPolygonObj.polygonPositions.map(toDegrees);
		outerRing.push(outerRing[0]);
		if (!turf.booleanPointInPolygon(point, turf.polygon([outerRing]))) {
			return false;
		}
		const holes = entityObjPolygonObj.holes ?? [];
		for (let index = 0; index < holes.length; index++) {
			const holeRing = holes[index].map(toDegrees);
			holeRing.push(holeRing[0]);
			if (turf.booleanPointInPolygon(point, turf.polygon([holeRing]))) {
				return false;
			}
		}
		return true;
	};

	/** 移除挖孔预览实体。 */
	const removePreviewEntities = (): void => {
		if (previewLine) {
			drawDataSource.entities.remove(previewLine);
			previewLine = null;
		}
		if (previewPolygon) {
			drawDataSource.entities.remove(previewPolygon);
			previewPolygon = null;
		}
	};

	/** 移除挖孔过程中放置的全部临时顶点。 */
	const removePointEntities = (): void => {
		for (let index = 0; index < pointEntityList.length; index++) {
			drawDataSource.entities.remove(pointEntityList[index]);
		}
	};

	/** 销毁事件监听并恢复鼠标样式。 */
	const cleanupHoleDrawing = (): void => {
		document.removeEventListener('keydown', handleKeyDown);
		if (!handler.isDestroyed()) {
			handler.destroy();
		}
		if (mapContainer) {
			mapContainer.style.cursor = 'default';
		}
		viewer.canvas.style.cursor = 'default';
	};

	/** 按 Esc 取消挖孔。 */
	const handleKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape') {
			return;
		}
		event.preventDefault();
		cleanupHoleDrawing();
		removePreviewEntities();
		removePointEntities();
		cancelCallback();
	};

	document.addEventListener('keydown', handleKeyDown);

	handler.setInputAction((click) => {
		const cartesian = pickTerrainPosition(viewer, click.position);
		if (!cartesian) {
			return;
		}
		if (!isPositionInsideArea(cartesian)) {
			ElMessage.warning('挖孔顶点需位于测区内部');
			return;
		}
		// 注意:最后一个点是跟随鼠标的临时点,不能做距离过滤,否则点击永远被忽略
		holePositions.push(cartesian);
		const pointEntity = drawDataSource.entities.add({
			name: `polygonPoint`,
			position: new Cesium.CallbackProperty(function () {
				return cartesian;
			}, false),
			point: {
				pixelSize: 7.0,
				color: HOLE_POINT_COLOR.withAlpha(0.9),
				outlineWidth: 1,
				outlineColor: Cesium.Color.WHITE,
				heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
				disableDepthTestDistance: Number.POSITIVE_INFINITY,
			},
			customData: holePositions.length - 1,
		});
		pointEntityList.push(pointEntity);

		if (holePositions.length >= 2 && !previewLine) {
			previewLine = drawDataSource.entities.add({
				polyline: {
					positions: new Cesium.CallbackProperty(function () {
						return holePositions;
					}, false),
					material: HOLE_LINE_COLOR,
					width: 4,
					clampToGround: true,
				},
			});
		}
	}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

	handler.setInputAction((event) => {
		const currentPosition = pickTerrainPosition(viewer, event.endPosition);
		if (!currentPosition) {
			return;
		}
		if (holePositions.length === 1) {
			holePositions.push(currentPosition);
		}
		if (holePositions.length >= 2) {
			holePositions[holePositions.length - 1] = currentPosition;
		}
		if (holePositions.length >= 3 && !previewPolygon) {
			previewPolygon = drawDataSource.entities.add({
				polygon: {
					hierarchy: new Cesium.CallbackProperty(function () {
						return new Cesium.PolygonHierarchy(holePositions);
					}, false),
					material: HOLE_PREVIEW_FILL,
					outline: true,
					outlineColor: HOLE_LINE_COLOR,
					outlineWidth: 2,
					heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
				},
			});
		}
	}, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

	handler.setInputAction((click) => {
		if (holePositions.length < 3) {
			// 点位不足时视为取消
			cleanupHoleDrawing();
			removePreviewEntities();
			removePointEntities();
			cancelCallback();
			return;
		}
		const cartesian = pickTerrainPosition(viewer, click.position);
		if (cartesian) {
			holePositions[holePositions.length - 1] = cartesian;
		}

		// 自相交校验
		const holeRing = holePositions.map(toDegrees);
		holeRing.push(holeRing[0]);
		const kinks = turf.kinks(turf.polygon([holeRing]));
		if (kinks.features.length > 0) {
			ElMessage.warning('挖孔图形不允许自相交');
			cleanupHoleDrawing();
			removePreviewEntities();
			removePointEntities();
			cancelCallback();
			return;
		}

		cleanupHoleDrawing();
		removePreviewEntities();

		const holeIndex = (entityObjPolygonObj.holes ?? []).length;
		entityObjPolygonObj.holes = entityObjPolygonObj.holes ?? [];
		entityObjPolygonObj.holes.push(holePositions);

		// 顶点实体标记所属挖孔序号后转为正式可编辑顶点
		for (let index = 0; index < pointEntityList.length; index++) {
			const editablePoint = pointEntityList[index] as Cesium.Entity & { ringIndex?: number };
			editablePoint.ringIndex = holeIndex;
		}
		entityObjPolygonObj.holePointEntityList = entityObjPolygonObj.holePointEntityList ?? [];
		entityObjPolygonObj.holePointEntityList.push(pointEntityList);

		const holeLineEntity = drawDataSource.entities.add({
			name: 'polygonLine',
			polyline: {
				positions: new Cesium.CallbackProperty(() => {
					const ring = entityObjPolygonObj.holes![holeIndex];
					return [...ring, ring[0]];
				}, false),
				material: HOLE_LINE_COLOR,
				width: 4,
				clampToGround: true,
			},
			ringIndex: holeIndex,
		});
		entityObjPolygonObj.holeLineEntityList = entityObjPolygonObj.holeLineEntityList ?? [];
		entityObjPolygonObj.holeLineEntityList.push(holeLineEntity);

		// 更新测区层级，使挖孔立即生效
		entityObjPolygonObj.polygonEntity.polygon.hierarchy = new Cesium.CallbackProperty(() => {
			return buildPolygonHierarchy(entityObjPolygonObj.polygonPositions, entityObjPolygonObj.holes);
		}, false);

		polygonPositions = entityObjPolygonObj.polygonPositions;
		polygonHoles = entityObjPolygonObj.holes;

		callback(entityObjPolygonObj);
	}, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

	return cleanupHoleDrawing;
}

/**
 * 删除指定挖孔环：移除其轮廓线与顶点实体，并重排剩余挖孔的索引与实体回调。
 */
export function removeHole(entityObjPolygonObj: PolygonDrawingResult, holeIndex: number): boolean {
	const holes = entityObjPolygonObj.holes ?? [];
	if (holeIndex < 0 || holeIndex >= holes.length) {
		return false;
	}
	drawDataSource = window.mainViewer.dataSources.getByName('drawDataSource').at(-1);

	const holeLineEntity = entityObjPolygonObj.holeLineEntityList?.[holeIndex];
	if (holeLineEntity) {
		drawDataSource.entities.remove(holeLineEntity);
	}
	const holePoints = entityObjPolygonObj.holePointEntityList?.[holeIndex] ?? [];
	for (let index = 0; index < holePoints.length; index++) {
		drawDataSource.entities.remove(holePoints[index]);
	}

	holes.splice(holeIndex, 1);
	entityObjPolygonObj.holeLineEntityList?.splice(holeIndex, 1);
	entityObjPolygonObj.holePointEntityList?.splice(holeIndex, 1);

	// 剩余挖孔索引整体前移：重打 ringIndex 标签并重绑轮廓线回调（原闭包捕获了旧索引）
	for (let index = 0; index < holes.length; index++) {
		const lineEntity = entityObjPolygonObj.holeLineEntityList?.[index];
		if (lineEntity) {
			(lineEntity as Cesium.Entity & { ringIndex?: number }).ringIndex = index;
			lineEntity.polyline.positions = new Cesium.CallbackProperty(() => {
				const ring = entityObjPolygonObj.holes![index];
				return ring ? [...ring, ring[0]] : [];
			}, false);
		}
		const points = entityObjPolygonObj.holePointEntityList?.[index] ?? [];
		for (let pointIndex = 0; pointIndex < points.length; pointIndex++) {
			(points[pointIndex] as Cesium.Entity & { ringIndex?: number }).ringIndex = index;
		}
	}

	entityObjPolygonObj.polygonEntity.polygon.hierarchy = new Cesium.CallbackProperty(() => {
		return buildPolygonHierarchy(entityObjPolygonObj.polygonPositions, entityObjPolygonObj.holes);
	}, false);

	polygonHoles = entityObjPolygonObj.holes ?? [];
	window.mainViewer.scene.requestRender();
	return true;
}

/**
 * 更新移动顶点影响到的指定边标签。
 */
function updatePolygonEdgeLabel(entityObjPolygonObj, edgeIndex: number) {
	const positions = entityObjPolygonObj.polygonPositions;
	const nextIndex = (edgeIndex + 1) % positions.length;
	updateDistanceLabel(entityObjPolygonObj.entityLabelList[edgeIndex], positions[edgeIndex], positions[nextIndex]);
}

/**
 * 使用椭球表面距离更新边长标签和标签位置。
 */
function updateDistanceLabel(labelEntity, start: Cesium.Cartesian3, end: Cesium.Cartesian3) {
	if (!labelEntity) {
		return;
	}
	const metrics = calculateEdgeMetrics(start, end);
	labelEntity.position = new Cesium.ConstantPositionProperty(metrics.middlePosition);
	labelEntity.label.text = `${metrics.distance.toFixed(2)}米`;
}

/**
 * 计算边的椭球表面距离及地理中点。
 */
function calculateEdgeMetrics(start: Cesium.Cartesian3, end: Cesium.Cartesian3): { distance: number; middlePosition: Cesium.Cartesian3 } {
	const startCartographic = Cesium.Cartographic.fromCartesian(start);
	const endCartographic = Cesium.Cartographic.fromCartesian(end);
	const geodesic = new Cesium.EllipsoidGeodesic(startCartographic, endCartographic);
	const middleCartographic = geodesic.interpolateUsingFraction(0.5);
	const middlePosition = Cesium.Cartographic.toCartesian(middleCartographic);
	return {
		distance: geodesic.surfaceDistance,
		middlePosition,
	};
}

/**
 * 仅拾取 Cesium 地形表面，避免测区顶点落到 3D Tiles 或无深度区域。
 */
export function pickTerrainPosition(viewer: Cesium.Viewer, windowPosition: Cesium.Cartesian2): Cesium.Cartesian3 | undefined {
	const ray = viewer.camera.getPickRay(windowPosition);
	if (!ray) {
		return undefined;
	}
	return viewer.scene.globe.pick(ray, viewer.scene);
}

/**
 * 判断某位置是否落在某个挖孔环内部（孔区域无实体可拾取，右键删除需几何判断）。
 * @returns 命中的挖孔索引，未命中返回 -1
 */
export function findHoleIndexAtPosition(position: Cesium.Cartesian3, holes: Cesium.Cartesian3[][] | undefined): number {
	if (!holes || holes.length === 0) {
		return -1;
	}
	const cartographic = Cesium.Cartographic.fromCartesian(position);
	const point = [Cesium.Math.toDegrees(cartographic.longitude), Cesium.Math.toDegrees(cartographic.latitude)];
	for (let index = 0; index < holes.length; index++) {
		const ring = holes[index].map((vertex) => {
			const vertexCartographic = Cesium.Cartographic.fromCartesian(vertex);
			return [Cesium.Math.toDegrees(vertexCartographic.longitude), Cesium.Math.toDegrees(vertexCartographic.latitude)];
		});
		ring.push(ring[0]);
		if (turf.booleanPointInPolygon(point, turf.polygon([ring]))) {
			return index;
		}
	}
	return -1;
}

function iskinksBoolean() {
	const ellipsoid = window.mainViewer.scene.globe.ellipsoid;
	const rings = [polygonPositions, ...(polygonHoles ?? [])];
	let hasKinks = false;

	for (let ringIndex = 0; ringIndex < rings.length; ringIndex++) {
		const ring = rings[ringIndex];
		if (!ring || ring.length < 3) {
			continue;
		}
		const outPoint = ring.map((e) => {
			const cartographic = ellipsoid.cartesianToCartographic(e);
			return [Cesium.Math.toDegrees(cartographic.longitude), Cesium.Math.toDegrees(cartographic.latitude)];
		});
		outPoint.push(outPoint[0]);
		const kinks = turf.kinks(turf.polygon([outPoint]));
		if (kinks.features.length > 0) {
			hasKinks = true;
			break;
		}
	}

	isKinks = hasKinks;

	let dom: any = document.getElementById('map-error-tip');

	if (isKinks) {
		dom.style.display = 'block';
	} else {
		dom.style.display = 'none';
	}
}

/**
 * 重置测区自相交状态和错误提示。
 */
function resetKinksState(): void {
	isKinks = false;
	const dom = document.getElementById('map-error-tip');
	if (dom) {
		dom.style.display = 'none';
	}
}

function upEntityColor(polygonEntity, lineEntity, lastLineEntity?) {
	if (isKinks) {
		polygonEntity.polygon.material = Cesium.Color.RED.withAlpha(POLYGON_KINKS_FILL_ALPHA);
		lineEntity.polyline.material = Cesium.Color.RED;
		if (lastLineEntity) {
			lastLineEntity.polyline.material = Cesium.Color.RED;
		}
	} else {
		polygonEntity.polygon.material = createPolygonFillMaterial();
		lineEntity.polyline.material = Cesium.Color.DODGERBLUE;
		if (lastLineEntity) {
			lastLineEntity.polyline.material = Cesium.Color.DODGERBLUE;
		}
	}
}
