/**
 * 功能名称：航线相机参数
 * 日    期：2026/07/17
 */

export interface CameraPhotoSpecification {
	model: string;
	lens: string;
	diagonalFovDegrees: number;
	photoWidthPixels: number;
	photoHeightPixels: number;
}

export interface CameraFieldOfView {
	horizontalDegrees: number;
	verticalDegrees: number;
}

/** 测绘广角镜头的物理尺寸，焦距和传感器单位为毫米。 */
export interface MappingLens {
	focalLengthMm: number;
	sensorWidthMm: number;
	sensorHeightMm: number;
	imageWidthPx: number;
	imageHeightPx: number;
}

/** M3TD 广角照片规格，82° 为对角视场角。 */
export const M3TD_WIDE_CAMERA: CameraPhotoSpecification = {
	model: 'M3TD',
	lens: 'wide',
	diagonalFovDegrees: 82,
	photoWidthPixels: 4032,
	photoHeightPixels: 3024,
};

/**
 * 根据对角 FOV 和照片纵横比推导水平、垂直 FOV。
 */
export function calculateCameraFieldOfView(specification: CameraPhotoSpecification): CameraFieldOfView {
	if (specification.diagonalFovDegrees <= 0 || specification.diagonalFovDegrees >= 180) {
		throw new Error('相机对角视场角无效');
	}
	if (specification.photoWidthPixels <= 0 || specification.photoHeightPixels <= 0) {
		throw new Error('相机照片尺寸无效');
	}

	const diagonalPixels = Math.hypot(specification.photoWidthPixels, specification.photoHeightPixels);
	const diagonalHalfTangent = Math.tan((specification.diagonalFovDegrees * Math.PI) / 360);
	const horizontalHalfTangent = diagonalHalfTangent * (specification.photoWidthPixels / diagonalPixels);
	const verticalHalfTangent = diagonalHalfTangent * (specification.photoHeightPixels / diagonalPixels);

	return {
		horizontalDegrees: (2 * Math.atan(horizontalHalfTangent) * 180) / Math.PI,
		verticalDegrees: (2 * Math.atan(verticalHalfTangent) * 180) / Math.PI,
	};
}

/**
 * 用镜头焦距和传感器尺寸计算水平、垂直视场角。
 */
export function fieldOfViewFromLens(lens: MappingLens): CameraFieldOfView {
	return {
		horizontalDegrees: lensFieldOfViewDegrees(lens.sensorWidthMm, lens.focalLengthMm),
		verticalDegrees: lensFieldOfViewDegrees(lens.sensorHeightMm, lens.focalLengthMm),
	};
}

/**
 * 正射 GSD，单位 cm/px。
 */
export function calculateGsdCentimeters(heightMeters: number, lens: MappingLens): number {
	return (heightMeters * lens.sensorWidthMm * 100) / (lens.focalLengthMm * lens.imageWidthPx);
}

/**
 * 由正射 GSD 反算相对航高，单位米。
 */
export function calculateHeightFromGsd(gsdCentimeters: number, lens: MappingLens): number {
	return (gsdCentimeters * lens.focalLengthMm * lens.imageWidthPx) / (lens.sensorWidthMm * 100);
}

/**
 * 云台俯仰角相对水平面，-90 为正射。倾斜时按斜距放大 GSD。
 */
export function obliqueGsdScale(gimbalPitchDegrees: number): number {
	const sine = Math.sin((Math.abs(gimbalPitchDegrees) * Math.PI) / 180);
	if (sine < 0.05) {
		return 1;
	}
	return 1 / sine;
}

function lensFieldOfViewDegrees(sensorMm: number, focalLengthMm: number): number {
	return (2 * Math.atan(sensorMm / (2 * focalLengthMm)) * 180) / Math.PI;
}
