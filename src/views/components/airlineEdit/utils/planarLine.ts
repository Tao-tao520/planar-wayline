/**
 * 功能名称：面状航线工具类
 * 日    期：2025/06/11 17:59:20
 */
import * as Cesium from 'cesium';
import startPoint_icon from '../img/start_point.svg';
import globeConfig from '../config/planarConfig';
import { CreateFrustum } from './frustum';
import { setViewer, calcDestPoint, getCartesianHeight, modifyCartesianHeight, cartesian2LngLat, lngLat2Cartesian, getHeading, getTerrainHeight } from './map';
import { debounce, deepClone, createTextCanvas } from './comm';
import { updateControlPanelHeight } from './keyBinding';
import arrow from '../img/arrow.png';
import { ElMessage } from 'element-plus';
import { reactive } from 'vue';
import * as turf from '@turf/turf';
import { getImg } from './comm';

// 航线点数组
export let airLinePointData: any = reactive({
	startPoint: null, // 起飞点
	startPointList: [], // 存放生成的起飞点
	pointList: [], // 航线点
	activePointIndex: 0, // 当前选中的航线点索引
});

const START_POINT_TIP_CLASS = 'draw-center-tips';
const START_POINT_TIP_TEXT = '点击地图设置参考起飞点';

/** 在 .wayMap 上显示起飞点拾取中心提示 */
function showStartPointTip(): void {
	const mapContainer = document.querySelector('.wayMap');
	if (!(mapContainer instanceof HTMLElement)) {
		return;
	}
	let tip = mapContainer.querySelector(`.${START_POINT_TIP_CLASS}`);
	if (!(tip instanceof HTMLElement)) {
		tip = document.createElement('div');
		tip.className = START_POINT_TIP_CLASS;
		tip.textContent = START_POINT_TIP_TEXT;
		mapContainer.appendChild(tip);
	}
}

/** 移除起飞点拾取中心提示 */
export function hideStartPointTip(): void {
	document.querySelector(`.wayMap .${START_POINT_TIP_CLASS}`)?.remove();
}

/** 起飞点拾取光标（需同步到 viewer.canvas，外部复用地图时 .wayMap 无实际悬停） */
export function setStartPointCursor(viewer: Cesium.Viewer, enabled: boolean): void {
	const cursor = enabled ? `url(${startPoint_icon}) 32 32, auto` : '';
	viewer.canvas.style.cursor = cursor;
	const cesiumContainer = document.getElementById('cesiumContainer');
	if (cesiumContainer) {
		cesiumContainer.style.cursor = cursor;
	}
	if (enabled) {
		showStartPointTip();
	} else {
		hideStartPointTip();
	}
}

export function addStartPoint(viewer: Cesium.Viewer, cb?: Function) {
	const mapContainer = document.querySelector('.wayMap') as HTMLElement;
	if (mapContainer) {
		// 设置自定义光标样式（class 供自有地图容器；canvas 供外部复用 Cesium）
		mapContainer.classList.add('map-menu-panel');
		setStartPointCursor(viewer, true);
		// 启动地图单击事件
		addMapLeftClickEvent(viewer, (cartesian?, option?) => {
			mapContainer.classList.remove('map-menu-panel');
			setStartPointCursor(viewer, false);
			if (cb) {
				cb(cartesian, option);
				return;
			}
			if (!window.miniViewer) return;
			// 修改小窗口相机
			setViewer(window.miniViewer, {
				destination: cartesian,
				orientation: {
					heading: option.heading - Cesium.Math.toRadians(90),
					pitch: option.pitch - Cesium.Math.toRadians(90),
					roll: option.roll,
				},
			});
		});
	} else {
		console.warn('未找到地图容器');
	}
}

/**
 * 添加map点击事件
 * 添加起飞点
 */
export function addMapLeftClickEvent(viewer: Cesium.Viewer | null, cb: Function) {
	if (!viewer) return;
	const handler = viewer.screenSpaceEventHandler;
	handler.setInputAction((e) => {
		// 从相机位置和鼠标事件位置生成射线
		const ray: any = viewer.camera.getPickRay(e.position);
		// 地球表面拾取点
		const cartesian: any = viewer.scene.globe.pick(ray, viewer.scene);
		// 绘制起飞轨迹
		drawFlyStartLine(viewer, cartesian);
		// 去除点击事件
		handler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);

		// 笛卡尔转为弧度
		const cartographic = Cesium.Cartographic.fromCartesian(cartesian ? cartesian : globeConfig.position);
		// 获取到海拔高度
		const hb = viewer.scene.globe.getHeight(cartographic) || 0;

		// 初始高度设置
		const height = hb;
		if (globeConfig.heightType === 1) {
			globeConfig.lineHeight = Number(hb.toFixed(1)) + 100;
		}
		const position = Cesium.Cartesian3.fromDegrees(Cesium.Math.toDegrees(cartographic.longitude), Cesium.Math.toDegrees(cartographic.latitude), height);
		globeConfig.flyPosition = position as any;

		// 回调逻辑
		cb(position, globeConfig);
	}, Cesium.ScreenSpaceEventType.LEFT_CLICK);
}

/**
 * 绘制航线起飞点+安全高度轨迹线
 */
export function drawFlyStartLine(viewer: Cesium.Viewer, cartesian: Cesium.Cartesian3) {
	// 删除上一次绘制的起飞点
	if (airLinePointData.startPoint) {
		viewer.entities.remove(airLinePointData.startPoint);
	}

	const startPoint: Cesium.Entity.ConstructorOptions = {
		id: 'startPoint',
		position: cartesian,
		billboard: {
			image: startPoint_icon,
			scale: 0.8,
			horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
			verticalOrigin: Cesium.VerticalOrigin.CENTER,
			// 紧贴地形
			heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
			// 可见范围
			distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 200000),
			// 缩放比例
			scaleByDistance: new Cesium.NearFarScalar(1.5e2, 1, 1.5e7, 0.3),
			// 半透明度
			translucencyByDistance: new Cesium.NearFarScalar(0, 0, 200, 0.6),
		},
	};
	const point = viewer.entities.add(startPoint);
	airLinePointData.startPoint = point;
	// 更改全局起飞点状态为已设置
	globeConfig.isSetTakeoffPoint = true;
}

/**
 * 绘制起始点
 * @param {Cesium.Cartesian3} point
 */
export function drawStartPoint(point) {
	window.mainViewer.entities.removeById(`air_start_point`);
	const pointEntity: any = {
		name: 'point',
		id: `air_start_point`,
		position: point,
		billboard: {
			image: getImg(1),
			width: 30,
			height: 30,
			// 始终面向相机
			eyeOffset: new Cesium.Cartesian3(0, 0, 0),
			pixelOffset: new Cesium.Cartesian2(0, -15),
		},
		properties: globeConfig,
	};

	window.mainViewer.entities.add(pointEntity);
}

/**
 * 获取起飞点及起飞点地面坐标
 * @param {Cesium.Cartesian3} point
 */
export function getStartPointHeight(point): Array<Cesium.Cartesian3> {
	let points: Array<Cesium.Cartesian3> = [];

	const ellipsoid = window.mainViewer.scene.globe.ellipsoid;
	const cartographic = ellipsoid.cartesianToCartographic(point);

	let lon = Cesium.Math.toDegrees(cartographic.longitude);
	let lat = Cesium.Math.toDegrees(cartographic.latitude);

	points.push(Cesium.Cartesian3.fromDegrees(lon, lat, 0));

	points.push(point);

	return points;
}

/**
 * 计算面积
 * @param {Cesium.Cartesian3} positions 外环顶点
 * @param {Array<Array<Cesium.Cartesian3>>} holes 挖孔环顶点集合
 * @returns {number} 单位：平方米
 */
export function calculateArea(positions: Array<Cesium.Cartesian3>, holes?: Array<Array<Cesium.Cartesian3>>) {
	const ellipsoid = window.mainViewer.scene.globe.ellipsoid;
	const toRing = (ringPositions: Array<Cesium.Cartesian3>): any => {
		const ring: any = ringPositions.map((e) => {
			const cartographic = ellipsoid.cartesianToCartographic(e);
			return [Cesium.Math.toDegrees(cartographic.longitude), Cesium.Math.toDegrees(cartographic.latitude)];
		});
		ring.push(ring[0]);
		return ring;
	};

	const rings: any[] = [toRing(positions)];
	if (holes) {
		for (let index = 0; index < holes.length; index++) {
			if (holes[index] && holes[index].length >= 3) {
				rings.push(toRing(holes[index]));
			}
		}
	}

	let polygon = turf.polygon(rings);

	return turf.area(polygon);
}

/**
 * 处理两点之间连线是否超出边界 // 待完善
 * @param {Cesium.Cartesian3} points
 * @param sidePoint
 */
export function handleLineOutOfBoundary(points: Array<[]>, sidePoint) {
	let outPoint: any[] = [];

	let polygon = turf.polygon([sidePoint]);

	let np = [...sidePoint];

	np.pop();

	let line = turf.lineString(np);

	for (let i = 0; i < points.length - 1; i++) {
		let start = turf.point(points[i]);

		let stop = turf.point(points[i + 1]);

		let sliced = turf.lineSlice(start, stop, line);

		let nowLine = turf.lineString([points[i], points[i + 1]]);

		// console.log('边缘计算', sliced);
		let booleanContains = turf.booleanContains(polygon, nowLine);

		if (sliced.geometry.coordinates.length >= 3 && !booleanContains) {
			// 判断方向
			let slicedPoint = sliced.geometry.coordinates;

			let dis1 = turf.distance(turf.point(slicedPoint[0]), points[i], { units: 'meters' });
			let dis2 = turf.distance(turf.point(slicedPoint[slicedPoint.length - 1]), points[i], { units: 'meters' });

			if (dis1 > dis2) {
				slicedPoint = slicedPoint.reverse();
			}

			outPoint.push(...slicedPoint);
			// console.log('外部');
		} else {
			outPoint.push(points[i]);
			// console.log('内部');
		}

		// console.log('交点数', sliced.geometry.coordinates.length);
	}
	outPoint.push(points[points.length - 1]);

	console.log('边缘计算结果', outPoint);

	return outPoint;
}

/**
 * 将 linesArrs 转换为经纬度格式
 */
export function convertToPositions(flatArray) {
	let positions: any = [];
	let i = 0;
	while (i < flatArray.length) {
		positions.push(flatArray.slice(i, i + 3));
		i += 3;
	}

	positions = positions.map((res) => {
		let height = 0;
		if (globeConfig.heightType == 1) {
			height = globeConfig.lineHeight;
		} else if (globeConfig.heightType == 2) {
			height = getRelativeHeight(globeConfig.flyPosition as any, globeConfig.lineHeight);
		} else {
			height = getHeight(res[0], res[1]);
		}
		return Cesium.Cartesian3.fromDegrees(res[0], res[1], height);
	});
	return positions;
}

/**
 * 相对地形高度
 * @param {number} longitude
 * @param {number} latitude
 * @returns {number} 高度
 */
function getHeight(longitude, latitude) {
	let c3 = Cesium.Cartesian3.fromDegrees(longitude, latitude);

	// 笛卡尔转为弧度
	const cartographic = Cesium.Cartographic.fromCartesian(c3);
	// 获取到海拔高度
	const hb: any = window.mainViewer.scene.globe.getHeight(cartographic);

	console.log('地形高度', hb);

	return hb + globeConfig.lineHeight;
}

/**
 * 相对起飞点高度
 * @param {Cesium.Cartesian3} position 相对起飞点
 * @param {number} height 相对高度
 */
function getRelativeHeight(position: Cesium.Cartesian3, height: number) {
	// 笛卡尔转为弧度
	const cartographic = Cesium.Cartographic.fromCartesian(position);

	// 获取到海拔高度
	const hb: any = window.mainViewer.scene.globe.getHeight(cartographic);

	return hb + height;
}
