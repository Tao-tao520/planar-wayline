/**
 * 功能名称：航线 Cesium 渲染器
 * 日    期：2026/07/29
 */
import * as Cesium from 'cesium';
import { Ref } from 'vue';
import { drawStartPoint } from '../utils/planarLine';
import { resolveIndicatorHeightFromSegments } from '../utils/lineAngleIndicator';
import { CartesianRouteSegment } from '../utils/planarTerrain';

const ROUTE_PREVIEW_READY_TIMEOUT = 10000;

/** useCesiumRenderer 所需的外部上下文 */
export interface CesiumRendererContext {
	/** Cesium CustomDataSource，存放航线实体 */
	get drawDataSource(): Cesium.CustomDataSource | null;
	/** 当前路线计算版本，用于废弃旧渲染任务 */
	get routeCalculationVersion(): number;
	/** 航线是否已绘制（响应式） */
	hasRoute: Ref<boolean>;
	/** 更新角度指示器高度 */
	setLineAngleIndicatorHeight(value: number): void;
}

/**
 * 管理航线实体的绘制、预览等待与清理。
 */
export class RouteRenderer {
	private ctx: CesiumRendererContext;
	private routeEntityIds: string[] = [];
	private routePreviewReadyRemoveListener: (() => void) | null = null;
	private routePreviewReadyTimer: ReturnType<typeof setTimeout> | null = null;
	private routePreviewReadyResolve: (() => void) | null = null;

	constructor(ctx: CesiumRendererContext) {
		this.ctx = ctx;
	}

	/**
	 * 将全部航段合并为一条连续折线绘制，保证航线始终为一条线
	 * （含绕开禁飞区挖孔的过渡段），避免逐段渲染在接头处出现断点。
	 * @param segments 笛卡尔坐标航段列表
	 */
	drawFlightPath(segments: CartesianRouteSegment[]): void {
		const dataSource = this.ctx.drawDataSource;
		if (!dataSource) {
			return;
		}

		this.clearRoutePreview();
		let firstScanPoint: Cesium.Cartesian3 | null = null;
		const mergedPositions: Cesium.Cartesian3[] = [];
		for (let index = 0; index < segments.length; index++) {
			const segment = segments[index];
			if (!firstScanPoint && segment.type === 'scan' && segment.positions.length > 0) {
				firstScanPoint = segment.positions[0];
			}
			for (let pointIndex = 0; pointIndex < segment.positions.length; pointIndex++) {
				const position = segment.positions[pointIndex];
				const previous = mergedPositions[mergedPositions.length - 1];
				if (previous && Cesium.Cartesian3.distanceSquared(previous, position) <= Cesium.Math.EPSILON7) {
					continue;
				}
				mergedPositions.push(position);
			}
		}

		dataSource.entities.suspendEvents();
		if (mergedPositions.length >= 2) {
			const id = 'planar_route_line';
			this.routeEntityIds.push(id);
			dataSource.entities.add({
				id,
				name: '航线',
				polyline: {
					positions: mergedPositions,
					width: 2,
					material: Cesium.Color.PALEGREEN,
					arcType: Cesium.ArcType.GEODESIC,
				},
			});
		}
		dataSource.entities.resumeEvents();

		if (firstScanPoint) {
			drawStartPoint(firstScanPoint);
		}
		const indicatorHeight = resolveIndicatorHeightFromSegments(segments);
		if (indicatorHeight !== null) {
			this.ctx.setLineAngleIndicatorHeight(indicatorHeight);
		}
		this.ctx.hasRoute.value = this.routeEntityIds.length > 0;
		window.mainViewer?.scene.requestRender();
	}

	/**
	 * 等待当前航线实体对应的 Cesium 静态几何进入可显示状态。
	 * @param version 触发本次计算的版本号
	 */
	waitForRoutePreviewReady(version: number): Promise<void> {
		const viewer = window.mainViewer;
		if (!viewer || !this.ctx.drawDataSource || this.routeEntityIds.length === 0) {
			return Promise.resolve();
		}

		this.cancelRoutePreviewReadyWait();
		return new Promise((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) {
					return;
				}
				settled = true;
				this.routePreviewReadyResolve = null;
				this.cancelRoutePreviewReadyWait();
				resolve();
			};
			const checkReady = () => {
				if (version !== this.ctx.routeCalculationVersion || this.routeEntityIds.length === 0) {
					finish();
					return;
				}
				const isReady = viewer.dataSourceDisplay.update(viewer.clock.currentTime);
				if (isReady) {
					finish();
					return;
				}
				viewer.scene.requestRender();
			};

			this.routePreviewReadyResolve = resolve;
			this.routePreviewReadyRemoveListener = viewer.scene.postRender.addEventListener(checkReady);
			this.routePreviewReadyTimer = setTimeout(finish, ROUTE_PREVIEW_READY_TIMEOUT);
			viewer.scene.requestRender();
		});
	}

	/**
	 * 取消当前航线预览就绪等待，避免旧版本监听器继续占用渲染循环。
	 */
	cancelRoutePreviewReadyWait(): void {
		const resolve = this.routePreviewReadyResolve;
		this.routePreviewReadyResolve = null;
		if (this.routePreviewReadyRemoveListener) {
			this.routePreviewReadyRemoveListener();
			this.routePreviewReadyRemoveListener = null;
		}
		if (this.routePreviewReadyTimer) {
			clearTimeout(this.routePreviewReadyTimer);
			this.routePreviewReadyTimer = null;
		}
		if (resolve) {
			resolve();
		}
	}

	/**
	 * 清理上一版航线预览，保留测区绘制实体与角度指示。
	 */
	clearRoutePreview(): void {
		this.cancelRoutePreviewReadyWait();
		const dataSource = this.ctx.drawDataSource;
		if (dataSource) {
			for (let index = 0; index < this.routeEntityIds.length; index++) {
				dataSource.entities.removeById(this.routeEntityIds[index]);
			}
		}
		this.routeEntityIds = [];
		this.ctx.hasRoute.value = false;
		window.mainViewer?.entities.removeById('air_start_point');
	}

	/** 返回当前已绘制的航线实体 ID 列表（只读副本）。 */
	getRouteEntityIds(): readonly string[] {
		return this.routeEntityIds;
	}
}
