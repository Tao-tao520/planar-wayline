/**
 * 航线默认配置
 */
import { reactive, watchEffect } from 'vue';
import * as Cesium from 'cesium';
import { deepClone } from '../utils/comm';

/**
 * 相机最短等时拍照间隔（秒）。
 * cameraConfig 无机型连拍能力字段；导出原先用 0.7 作通用下限。
 * 同测区司空样例：航向间距 D≈10.7 m、限速 v≈6.2 m/s → Δt_min≈1.72 s。
 * 作为可调常量，用于 v_max = D / Δt_min 与等时间隔 floor。
 */
export const MINIMUM_PHOTO_INTERVAL_SECONDS = 1.72;

/** 航线速度 UI/规划硬上限（m/s） */
export const PLANAR_SPEED_HARD_MAX = 15;

export interface PlanarConfig {
	isSetTakeoffPoint: boolean;
	flyPosition: Cesium.Cartesian3 | null;
	photokey: number;
	climbType: number;
	lineHeight: number;
	heightType: number;
	speed: number;
	/** 由拍照间距算出的建议限速（m/s），手动可调高至 15 */
	maxSpeed: number;
	smartObliqueGimbalPitch: number;
	smartObliqueEnable: boolean;
	smartObliqueSwingAngle: number;
	photoTriggerMode: 'time' | 'distance';
	spacing: number;
	takeoffSpeed: number;
	overlapW: number;
	overlapH: number;
	area: number;
	lineLength: number;
	takeoffClimbLength: number;
	flyTime: string;
	photoCount: number;
	linesArrs: number[];
	routeLinesArrs: number[][];
	lineAngle: number;
	polygonPositions: Cesium.Cartesian3[];
	position: Cesium.Cartesian3;
}

export const PLANAR_EDIT_DEFAULTS = {
	climbType: 1,
	lineHeight: 80,
	heightType: 2,
	speed: 10,
	maxSpeed: PLANAR_SPEED_HARD_MAX,
	smartObliqueGimbalPitch: -45,
	smartObliqueEnable: false,
	smartObliqueSwingAngle: 45,
	photoTriggerMode: 'time' as const,
	spacing: 50,
	takeoffSpeed: 15,
	overlapW: 70,
	overlapH: 80,
	lineAngle: 0,
};

const defaultConfig: PlanarConfig = {
	isSetTakeoffPoint: false, // 是否设置起飞点
	flyPosition: null,
	photokey: 1, // 拍照模式 1:广角  2:红外
	...PLANAR_EDIT_DEFAULTS,
	area: 0, // 面积
	lineLength: 0, // 航线长度
	takeoffClimbLength: 0, // 起飞点到首航点的引入长度，按过渡速度计时
	flyTime: '0', // 航线时间
	photoCount: 0, // 照片总数
	linesArrs: [], // 航线
	routeLinesArrs: [], // 分组航线
	polygonPositions: [], // 多边形点位信息
	position: Cesium.Cartesian3.fromDegrees(120, 30, 200), // 初始位置
};

const globeConfig = reactive<PlanarConfig>(deepClone(defaultConfig));

watchEffect(() => {
	const length = Math.max(0, Number(globeConfig.lineLength));
	const climbLength = Math.max(0, Number(globeConfig.takeoffClimbLength));
	const speed = Math.max(0.1, Number(globeConfig.speed));
	const takeoffSpeed = Math.max(0.1, Number(globeConfig.takeoffSpeed));

	if (length == 0 && climbLength == 0) {
		globeConfig.flyTime = '0';
	} else {
		// 航线本体按航线速度，起飞点到首航点整段按过渡速度，两段相加。
		const seconds = climbLength / takeoffSpeed + length / speed;
		globeConfig.flyTime = formatSeconds(seconds);
	}
});

function formatSeconds(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.round(seconds % 60);
	if (hours > 0) {
		return `${hours} h ${minutes} m ${secs} s`;
	}
	return `${minutes} m ${secs} s`;
}

/**
 * 由航向拍照间距与最短拍照间隔计算建议限速：v_suggest = D / Δt_min（不超过硬上限 15）。
 */
export function calculateMaxFlightSpeed(photoDistance: number, minIntervalSeconds: number = MINIMUM_PHOTO_INTERVAL_SECONDS): number {
	if (!Number.isFinite(photoDistance) || photoDistance <= 0) {
		return PLANAR_SPEED_HARD_MAX;
	}
	if (!Number.isFinite(minIntervalSeconds) || minIntervalSeconds <= 0) {
		return PLANAR_SPEED_HARD_MAX;
	}
	const maxSpeed = photoDistance / minIntervalSeconds;
	return Math.min(PLANAR_SPEED_HARD_MAX, Math.max(1, maxSpeed));
}

/**
 * 更新建议限速；硬钳制仅 1~15（与司空一致：建议可超，最高 15）。
 * @param photoDistance 航向拍照间距
 * @param syncToSuggested 重叠/航高等导致间距变化时，把当前速度同步为建议值
 */
export function applyFlightSpeedLimit(photoDistance: number, syncToSuggested = false): number {
	const suggested = Number(calculateMaxFlightSpeed(photoDistance).toFixed(1));
	globeConfig.maxSpeed = suggested;
	if (syncToSuggested) {
		globeConfig.speed = suggested;
		return globeConfig.speed;
	}
	const current = Number(globeConfig.speed);
	const speed = Number.isFinite(current) ? current : suggested;
	globeConfig.speed = Math.min(PLANAR_SPEED_HARD_MAX, Math.max(1, speed));
	return globeConfig.speed;
}

export default globeConfig;
