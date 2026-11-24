/**
 * 功能名称：面状航线
 * 日    期：2025/06/23 14:58:19
 */
import { computed, defineComponent, ExtractPropTypes, onUnmounted, ref, SetupContext } from 'vue';
import * as Cesium from 'cesium';
import { ElMessage, type UploadFile } from 'element-plus';
import Subscriber from '@cesium-extends/subscriber';
import BaseInstance from '@/utils/BaseInstance';
import AircraftSelect from './components/AircraftSelect.vue';
import CesiumMap from './components/CesiumMap.vue';
import SaveAirlineDialog from './components/SaveAirlineDialog.vue';
import PlanarRouteConfigPanel from './components/PlanarRouteConfigPanel.vue';
import { fieldOfViewFromLens } from './config/cameraConfig';
import { getSelectedAircraft, hasStoredAircraft } from './config/selectedAircraft';
import globeConfig, { applyFlightSpeedLimit, PLANAR_EDIT_DEFAULTS } from './config/planarConfig';
import { drawPolygon, movePolygon, PolygonDrawingResult } from './utils/drawPolygon';
import { calculateFiveDirectionRoutes, FiveDirectionRouteKey, FiveDirectionRoutePlan } from './utils/obliqueRoute';
import { buildPlanarKmz, PlanarKmzRoute } from './utils/planarKmzExport';
import { addStartPoint, calculateArea, hideStartPointTip, setStartPointCursor } from './utils/planarLine';
import { roundPlanarRouteSegments } from './utils/planarRouteTurn';
import { buildSmartObliqueRoute } from './utils/smartObliquePath';
import { calculateMaximumLineSpacing, calculatePhotoDistance, calculatePlanarRoute, LocalPoint, PlanarRouteSegment } from './utils/wayLineCalc';
import {
	calculateCartesianRouteLength,
	CartesianRouteSegment,
	createCartesianRouteSegments,
	createLocalCoordinateFrame,
	LocalRouteSegment,
	sampleMaximumTerrainHeightAlongSegments,
} from './utils/planarTerrain';
import { LineAngleHandler } from './composables/useLineAngle';
import { KmzImportHandler, PlannedRouteData as KmzPlannedRouteData } from './composables/useKmzImport';
import { RouteRenderer } from './composables/useCesiumRenderer';
import {
	calculateRouteDuration,
	formatRouteDuration,
	resolveFlightHeight,
	connectTakeoffToFirstWaypoint,
	getFirstLocalRoutePoint,
	getFirstCartesianRoutePoint,
	calculateRoutePhotoCount,
	flattenRouteCoordinates,
} from './composables/useRouteCalc';
let subscriber: Subscriber | null = null;


interface PickedEntityResult {
	id?: Cesium.Entity & { customData?: number };
}

interface RouteSummary {
	id: number;
	key: FiveDirectionRouteKey;
	label: string;
	totalLength: number;
	climbLength: number;
	photoCount: number;
}

interface ActiveRouteSummary extends RouteSummary {
	lengthText: string;
	timeText: string;
}

/** 与 KmzPlannedRouteData 结构完全一致，本地类型别名供本文件使用 */
type PlannedRouteData = KmzPlannedRouteData;

// 一、Emits 类型定义
type EmitsType = ''[];

// 二、Props 定义
const propDefine = {
	linkParam: {
		// 带入的参数
		type: String,
		default: '',
	},
};

// 三、组件信息定义
export default defineComponent({
	name: '',
	components: { AircraftSelect, CesiumMap, SaveAirlineDialog, PlanarRouteConfigPanel },
	emits: [''],
	props: propDefine,
	setup(props, ctx) {
		return new Instance(props, ctx);
	},
});

// 四、组件实例, 具体业务
export class Instance extends BaseInstance {
	private props: ExtractPropTypes<typeof propDefine>;
	private ctx: SetupContext<EmitsType>;

	// 全局属性
	globeConfig = globeConfig;
	flyPointStatus = ref(false);
	isAircraftSelectShow = ref(!hasStoredAircraft());
	aircraftLabel = computed(() => `面状航线 · ${getSelectedAircraft().name}`);
	isCalculating = ref(false);
	hasRoute = ref(false);
	activeRouteIndex = ref(0);
	routeSummaries = ref<RouteSummary[]>([]);
	openAircraftSelect = () => {
		this.isAircraftSelectShow.value = true;
	};
	photoTriggerOptions = [
		{ label: '等时间拍照', value: 'time' },
		{ label: '等距拍照', value: 'distance' },
	];
	entityObjPolygonObj: PolygonDrawingResult | null = null;
	drawDataSource: Cesium.CustomDataSource | null = null;
	isObliqueMode = computed(() => Number(globeConfig.climbType) === 2);
	isSmartOblique = computed(() => this.isObliqueMode.value && globeConfig.smartObliqueEnable && getSelectedAircraft().supportsSmartOblique);
	isImporting = ref(false);
	mapLoadingText = computed(() => (this.isImporting.value ? '航线导入中' : '航线计算中'));
	showSaveDialog = ref(false);
	saveDialogDefaultName = ref('');
	activeRouteSummary = computed<ActiveRouteSummary | null>(() => {
		const summary = this.routeSummaries.value[this.activeRouteIndex.value];
		if (!summary) {
			return null;
		}
		return {
			...summary,
			lengthText: summary.totalLength.toFixed(1),
			timeText: formatRouteDuration(calculateRouteDuration(summary.totalLength, summary.climbLength)),
		};
	});

	// 响应属性 | ref、reactive、computed
	delBtnRef = ref<HTMLElement | null>(null);

	private flyPot: Cesium.Cartesian3 | null = null;
	private routeCalculationVersion = 0;
	private photoDistance = 0;
	private plannedRoutes: PlannedRouteData[] = [];
	private stopPolygonDrawing: (() => void) | null = null;
	private polygonRightClickEnableTimer: ReturnType<typeof setTimeout> | null = null;
	private isPolygonRightClickEnabled = false;
	private kmzImporter!: KmzImportHandler;
	private lineAngleHandler!: LineAngleHandler;
	private routeRenderer!: RouteRenderer;
	/** 方向指示器绝对高度（略高于航线），重规划期间保留以免指示器掉到地面或消失 */
	private lineAngleIndicatorHeight = 0;

	constructor(props: ExtractPropTypes<typeof propDefine>, ctx: SetupContext<EmitsType>) {
		super();
		this.props = props;
		this.ctx = ctx;
		const self = this;
		this.kmzImporter = new KmzImportHandler({
			isImporting: this.isImporting,
			get entityObjPolygonObj() { return self.entityObjPolygonObj; },
			hasRoute: this.hasRoute,
			get routeCalculationVersion() { return self.routeCalculationVersion; },
			get isLineAngleManual() { return self.lineAngleHandler.isLineAngleManual; },
			setEntityObjPolygonObj: (v) => { this.entityObjPolygonObj = v; },
			setIsLineAngleManual: (v) => { this.lineAngleHandler.isLineAngleManual = v; },
			bumpVersion: () => ++this.routeCalculationVersion,
			clearCurrentRouteState: (p) => this.clearCurrentRouteState(p),
			setupPolygonSubscriber: () => this.setupPolygonSubscriber(),
			enablePolygonRightClick: () => { this.isPolygonRightClickEnabled = true; },
			applyPlannedRoutes: (r, p) => this.applyPlannedRoutes(r, p),
			waitForRoutePreviewReady: (v) => this.routeRenderer.waitForRoutePreviewReady(v),
			connectTakeoffToFirstWaypoint: (s) => connectTakeoffToFirstWaypoint(s),
			calculateRoutePhotoCount: (s, d, g) => calculateRoutePhotoCount(s, d, g),
			flattenRouteCoordinates: (s) => flattenRouteCoordinates(s),
		});
		this.routeRenderer = new RouteRenderer({
			get drawDataSource() { return self.drawDataSource; },
			get routeCalculationVersion() { return self.routeCalculationVersion; },
			hasRoute: this.hasRoute,
			setLineAngleIndicatorHeight: (v) => { this.lineAngleIndicatorHeight = v; },
		});
		this.lineAngleHandler = new LineAngleHandler({
			get drawDataSource() { return self.drawDataSource; },
			get entityObjPolygonObj() { return self.entityObjPolygonObj; },
			get lineAngleIndicatorHeight() { return self.lineAngleIndicatorHeight; },
			recalculateRoute: () => this.recalculateRoute(),
		});
		this.init();
	}

	/**
	 * 初始化组件生命周期。
	 */
	private init() {
		onUnmounted(() => {
			this.routeCalculationVersion++;
			this.routeRenderer.cancelRoutePreviewReadyWait();
			this.kmzImporter.cancelImportedTerrainCorrection();
			this.stopPolygonDrawing?.();
			this.stopPolygonDrawing = null;
			if (this.polygonRightClickEnableTimer) {
				clearTimeout(this.polygonRightClickEnableTimer);
				this.polygonRightClickEnableTimer = null;
			}
			this.lineAngleHandler.teardownSliderInteraction();
			this.lineAngleHandler.cancelIndicatorHide();
			this.cancelTakeoffPointSelection();
			subscriber?.destroy();
			subscriber = null;
		});
	}

	//#region 业务逻辑 - 面状航线

	/**
	 * 主地图初始化完成（自建球已定位西安）。
	 * @param viewer Cesium Viewer
	 */
	loadMainMap = async (viewer: Cesium.Viewer) => {
		window.mainViewer = viewer;
		this.drawDataSource = new Cesium.CustomDataSource('drawDataSource');
		await viewer.dataSources.add(this.drawDataSource);
		this.drawDataSource.show = true;

		addStartPoint(viewer, this.drawWay);
		viewer.scene.requestRender();
	};

	/**
	 * 注册测区删除浮层和顶点拖动交互。
	 */
	private setupPolygonSubscriber(): void {
		subscriber?.destroy();
		subscriber = new Subscriber(window.mainViewer, { pickResult: { enable: true, moveDebounce: 3000 } });
		subscriber.addExternal(() => {
			this.hideDeleteButton();
		}, 'LEFT_DOWN');
		subscriber.addExternal(() => {
			this.hideDeleteButton();
		}, 'MIDDLE_DOWN');
		subscriber.addExternal((movement) => {
			if (!this.isPolygonRightClickEnabled) {
				this.hideDeleteButton();
				return;
			}
			const pick = movement.position;
			const pickedObject = window.mainViewer.scene.pick(pick) as PickedEntityResult | undefined;
			if (!pick || pickedObject?.id?.name !== 'polygon') {
				this.hideDeleteButton();
				return;
			}
			this.showDeleteButtonAtCanvasPosition(pick);
			window.mainViewer.scene.requestRender();
		}, 'RIGHT_CLICK');
		subscriber.addExternal((movement) => {
			if (!this.entityObjPolygonObj) {
				return;
			}
			const pickedObject = window.mainViewer.scene.pick(movement.position) as PickedEntityResult | undefined;
			if (pickedObject?.id?.name !== 'polygonPoint' || pickedObject.id.customData === undefined) {
				this.hideDeleteButton();
				return;
			}

			this.entityObjPolygonObj.pointTndex = pickedObject.id.customData;
			movePolygon(this.entityObjPolygonObj, window.mainViewer, (value) => {
				this.entityObjPolygonObj = value as PolygonDrawingResult;
				this.updatePolygonArea();
				void this.recalculateRoute();
			});
		}, 'LEFT_CLICK');
	}

	/**
	 * 设置绘制测区所需的地图交互。
	 */
	drawWay = (position?: Cesium.Cartesian3) => {
		if (!position) {
			ElMessage.error('未获取到参考起飞点');
			return;
		}

		this.flyPot = position;
		this.lineAngleHandler.isLineAngleManual = false;
		this.isPolygonRightClickEnabled = false;
		if (this.polygonRightClickEnableTimer) {
			clearTimeout(this.polygonRightClickEnableTimer);
			this.polygonRightClickEnableTimer = null;
		}
		this.stopPolygonDrawing?.();
		this.stopPolygonDrawing = null;
		this.setupPolygonSubscriber();

		this.stopPolygonDrawing = drawPolygon(
			window.mainViewer,
			(value) => {
				this.stopPolygonDrawing = null;
				this.entityObjPolygonObj = value as PolygonDrawingResult;
				this.polygonRightClickEnableTimer = setTimeout(() => {
					this.isPolygonRightClickEnabled = true;
					this.polygonRightClickEnableTimer = null;
				}, 0);
				this.updatePolygonArea();
				void this.recalculateRoute();
			},
			() => {
				this.stopPolygonDrawing = null;
				this.delPoy();
			},
		);
	};

	/**
	 * 删除当前测区并重新进入绘制状态。
	 */
	delPoy = () => {
		const restartPosition = this.flyPot ?? globeConfig.flyPosition;
		this.clearCurrentRouteState(true);
		if (restartPosition) {
			this.drawWay(restartPosition);
		}
	};

	/**
	 * 清空当前测区与航线状态，导入时可同时清理旧起飞点。
	 */
	private clearCurrentRouteState(preserveTakeoff: boolean): void {
		this.routeCalculationVersion++;
		this.kmzImporter.cancelImportedTerrainCorrection();
		this.cancelTakeoffPointSelection();
		this.isPolygonRightClickEnabled = false;
		if (this.polygonRightClickEnableTimer) {
			clearTimeout(this.polygonRightClickEnableTimer);
			this.polygonRightClickEnableTimer = null;
		}
		this.stopPolygonDrawing?.();
		this.stopPolygonDrawing = null;
		this.lineAngleHandler.teardownSliderInteraction();
		this.lineAngleHandler.hideIndicator();
		this.drawDataSource?.entities.removeAll();
		window.mainViewer?.entities.removeById('air_start_point');
		this.hideDeleteButton();
		subscriber?.destroy();
		subscriber = null;
		this.entityObjPolygonObj = null;
		this.routeRenderer.clearRoutePreview();
		this.plannedRoutes = [];
		this.routeSummaries.value = [];
		this.activeRouteIndex.value = 0;
		this.lineAngleHandler.isLineAngleManual = false;
		this.isCalculating.value = false;
		this.photoDistance = 0;
		this.lineAngleIndicatorHeight = 0;
		this.hasRoute.value = false;
		globeConfig.area = 0;
		globeConfig.lineLength = 0;
		globeConfig.takeoffClimbLength = 0;
		globeConfig.photoCount = 0;
		globeConfig.linesArrs = [];
		globeConfig.routeLinesArrs = [];
		globeConfig.polygonPositions = [];
		if (!preserveTakeoff) {
			window.mainViewer?.entities.removeById('startPoint');
			this.flyPot = null;
			globeConfig.flyPosition = null;
			globeConfig.isSetTakeoffPoint = false;
		}
	}

	/**
	 * 重设参考起飞点；进入拾取时暂停测区绘制，避免同一点击同时落起飞点与测区顶点。
	 */
	updateFlyPoint = () => {
		this.flyPointStatus.value = !this.flyPointStatus.value;
		if (this.flyPointStatus.value) {
			const wasDrawingPolygon = !!this.stopPolygonDrawing;
			// 暂停未完成的测区绘制监听（独立 ScreenSpaceEventHandler，会与起飞点拾取抢点击）
			this.stopPolygonDrawing?.();
			this.stopPolygonDrawing = null;
			if (wasDrawingPolygon) {
				this.drawDataSource?.entities.removeAll();
			}
			// 已完成测区时暂停顶点点击订阅，同样避免抢 LEFT_CLICK
			subscriber?.destroy();
			subscriber = null;

			addStartPoint(window.mainViewer, (position?: Cesium.Cartesian3) => {
				this.flyPointStatus.value = false;
				if (position) {
					this.flyPot = position;
				}
				if (this.entityObjPolygonObj) {
					this.setupPolygonSubscriber();
					void this.recalculateRoute();
					return;
				}
				// 绘制中被打断或尚无测区：用新起飞点重新进入测区绘制
				if (position) {
					this.drawWay(position);
				}
			});
			return;
		}

		this.cancelTakeoffPointSelection();
		// 取消重设：恢复测区绘制或顶点编辑
		if (this.entityObjPolygonObj) {
			this.setupPolygonSubscriber();
		} else if (this.flyPot) {
			this.drawWay(this.flyPot);
		}
	};

	/**
	 * 退出参考起飞点拾取状态并恢复地图默认光标。
	 */
	private cancelTakeoffPointSelection(): void {
		this.flyPointStatus.value = false;
		const mapContainer = document.querySelector('.wayMap');
		if (mapContainer instanceof HTMLElement) {
			mapContainer.classList.remove('map-menu-panel');
		}
		if (window.mainViewer) {
			setStartPointCursor(window.mainViewer, false);
		} else {
			hideStartPointTip();
		}
		window.mainViewer?.screenSpaceEventHandler.removeInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK);
	}

	/**
	 * 修改航线采集方式。
	 */
	updateClimbType = (value: number) => {
		if (Number(globeConfig.climbType) === value) {
			return;
		}
		globeConfig.climbType = value;
		if (value === 2) {
			globeConfig.smartObliqueEnable = getSelectedAircraft().supportsSmartOblique;
			this.lineAngleHandler.isLineAngleManual = false;
		} else {
			globeConfig.smartObliqueEnable = false;
		}
		this.activeRouteIndex.value = 0;
		void this.recalculateRoute();
	};


	/**
	 * 切换地图当前显示的五向航线。
	 */
	selectObliqueRoute = (index: number) => {
		if (index < 0 || index >= this.plannedRoutes.length || index === this.activeRouteIndex.value) {
			return;
		}
		this.activeRouteIndex.value = index;
		const route = this.plannedRoutes[index];
		globeConfig.linesArrs = [...route.coordinates];
		this.routeRenderer.drawFlightPath(route.segments);
	};

	/** 委托到 lineAngleHandler */
	changeLineAngle = (delta: number) => this.lineAngleHandler.changeLineAngle(delta);
	/** 委托到 lineAngleHandler */
	beginLineAngleSliderInteraction = (event: PointerEvent) => this.lineAngleHandler.beginSliderInteraction(event);
	/** 委托到 lineAngleHandler */
	handleLineAngleSliderInput = (value: number | number[]) => this.lineAngleHandler.handleSliderInput(value);
	/** 委托到 lineAngleHandler */
	handleLineAngleSliderChange = (value: number | number[]) => this.lineAngleHandler.handleSliderChange(value);

	/**
	 * 选择 KMZ 文件后启动面状航线导入。
	 */
	handlePlanarKmzSelect = (file: UploadFile): void => {
		const raw = file.raw;
		if (!raw || this.isImporting.value) {
			return;
		}
		this.recordImportedWaylineName(raw.name);
		void this.kmzImporter.importPlanarKmz(raw);
	};

	/**
	 * 记录导入文件名，供保存航线时回填默认名称
	 * @param fileName 原始文件名
	 */
	private recordImportedWaylineName = (fileName: string) => {
		const raw = (fileName || '').trim();
		if (!raw) return;
		const name = raw.replace(/\.kmz$/i, '');
		if (name) {
			sessionStorage.setItem('aircraftName', name);
		}
	};

	/**
	 * 保存航线：打开弹窗，本地下载 KMZ
	 */
	handleSave = () => {
		if (!this.hasRoute.value) {
			ElMessage.warning('请先完成航线规划');
			return;
		}
		if (!globeConfig.flyPosition) {
			ElMessage.warning('请先设置参考起飞点');
			return;
		}
		this.openSaveDialog();
	};

	/**
	 * 打开保存航线弹窗
	 */
	openSaveDialog = () => {
		const cached = (sessionStorage.getItem('aircraftName') || '').trim();
		this.saveDialogDefaultName.value = cached;
		this.showSaveDialog.value = true;
	};

	/**
	 * 导出并下载 KMZ（交给保存弹窗调用）
	 * @param name 航线名称
	 */
	exportDownloadKmz = async (name: string) => {
		sessionStorage.setItem('aircraftName', name);
		const blob = await this.buildCurrentWaylineKmz();
		this.utilities.downloadBlobFile(blob, `${name}.kmz`);
	};

	/** 由当前地图航线生成 KMZ Blob。 */
	private buildCurrentWaylineKmz = async (): Promise<Blob> => {
		const polygonPositions = this.entityObjPolygonObj?.polygonPositions;
		if (!polygonPositions || polygonPositions.length < 3 || this.plannedRoutes.length === 0 || !this.hasRoute.value) {
			throw new Error('请先完成测区和航线规划');
		}
		if (!globeConfig.flyPosition) {
			throw new Error('请先设置参考起飞点');
		}

		const routes: PlanarKmzRoute[] = [];
		for (let routeIndex = 0; routeIndex < this.plannedRoutes.length; routeIndex++) {
			const route = this.plannedRoutes[routeIndex];
			routes.push({
				id: route.id,
				headingDegrees: route.headingDegrees,
				gimbalPitchDegrees: route.gimbalPitchDegrees,
				segments: route.exportSegments,
			});
		}

		const aircraft = getSelectedAircraft();
		return await buildPlanarKmz({
			isOblique: this.isObliqueMode.value,
			smartOblique: this.isSmartOblique.value,
			droneEnumValue: aircraft.droneEnumValue,
			droneSubEnumValue: aircraft.droneSubEnumValue,
			payloadEnumValue: aircraft.payloadEnumValue,
			polygonPositions,
			takeoffPosition: globeConfig.flyPosition,
			routes,
			lineAngle: Number(globeConfig.lineAngle),
			lineHeight: Number(globeConfig.lineHeight),
			heightType: Number(globeConfig.heightType),
			flightSpeed: applyFlightSpeedLimit(this.photoDistance),
			transitionalSpeed: Number(globeConfig.takeoffSpeed),
			overlapW: Number(globeConfig.overlapW),
			overlapH: Number(globeConfig.overlapH),
			gimbalPitchDegrees: this.isSmartOblique.value ? -Number(globeConfig.smartObliqueSwingAngle) : Number(globeConfig.smartObliqueGimbalPitch),
			photoTriggerMode: globeConfig.photoTriggerMode,
			photoDistance: this.photoDistance,
		});
	};

	/**
	 * 根据当前测区、地形、相机和面板参数重新生成正射或五向倾斜航线。
	 */
	recalculateRoute = async (): Promise<void> => {
		const polygonPositions = this.entityObjPolygonObj?.polygonPositions;
		if (!polygonPositions || polygonPositions.length < 3 || !window.mainViewer) {
			return;
		}

		const version = ++this.routeCalculationVersion;
		this.isCalculating.value = true;
		this.routeRenderer.clearRoutePreview();

		try {
			const frame = createLocalCoordinateFrame(polygonPositions);
			const localPolygon: LocalPoint[] = [];
			for (let index = 0; index < polygonPositions.length; index++) {
				localPolygon.push(frame.toLocal(polygonPositions[index]));
			}

			const heightResult = await resolveFlightHeight(window.mainViewer, frame, localPolygon);
			if (version !== this.routeCalculationVersion) {
				return;
			}

			const minimumGroundClearance = heightResult.minimumGroundClearance;
			if (minimumGroundClearance <= 0) {
				throw new Error('航线高度不足，无法规划');
			}

			const cameraFieldOfView = fieldOfViewFromLens(getSelectedAircraft().wideCamera);
			const crossTrackFov = cameraFieldOfView.horizontalDegrees;
			const halfFovRadians = (crossTrackFov * Math.PI) / 360;
			const footprintWidth = 2 * minimumGroundClearance * Math.tan(halfFovRadians);
			const maximumLineSpacing = calculateMaximumLineSpacing(minimumGroundClearance, crossTrackFov, Number(globeConfig.overlapW));
			const photoDistance = calculatePhotoDistance(minimumGroundClearance, cameraFieldOfView.verticalDegrees, Number(globeConfig.overlapH));
			// 建议限速随拍照间距更新；仅间距变化时同步为建议值，手动调速（最高 15）不被压回
			const previousPhotoDistance = this.photoDistance;
			const syncToSuggested = !(previousPhotoDistance > 0 && Math.abs(previousPhotoDistance - photoDistance) < 1e-6);
			applyFlightSpeedLimit(photoDistance, syncToSuggested);
			const takeoffPoint = globeConfig.flyPosition ? frame.toLocal(globeConfig.flyPosition) : undefined;
			let localRoutes: FiveDirectionRoutePlan[];
			if (this.isObliqueMode.value && !this.isSmartOblique.value) {
			const manualAngle = this.lineAngleHandler.isLineAngleManual ? Number(globeConfig.lineAngle) : undefined;
			const result = calculateFiveDirectionRoutes({
				polygon: localPolygon,
				maximumLineSpacing,
				footprintWidth,
				minimumGroundClearance,
				gimbalPitchDegrees: Number(globeConfig.smartObliqueGimbalPitch),
				takeoffPoint,
				manualAngle,
			});
			localRoutes = result.routes;
			if (!this.lineAngleHandler.isLineAngleManual) {
				globeConfig.lineAngle = Number(result.angle.toFixed(1));
			}
			globeConfig.spacing = Number(result.lineSpacing.toFixed(2));
		} else {
			const manualAngle = this.lineAngleHandler.isLineAngleManual ? Number(globeConfig.lineAngle) : undefined;
			const swingPitch = Number(globeConfig.smartObliqueSwingAngle);
			const orthoPlan = calculatePlanarRoute({
				polygon: localPolygon,
				maximumLineSpacing,
				footprintWidth,
				takeoffPoint,
				manualAngle,
			});
			const plan = this.isSmartOblique.value
				? buildSmartObliqueRoute({
						polygon: localPolygon,
						angle: orthoPlan.angle,
						lineSpacing: orthoPlan.lineSpacing,
						heightMeters: minimumGroundClearance,
						swingPitchDegrees: swingPitch,
						takeoffPoint,
					})
				: orthoPlan;
			if (!this.lineAngleHandler.isLineAngleManual) {
				globeConfig.lineAngle = Number(plan.angle.toFixed(1));
			}
				globeConfig.spacing = Number(plan.lineSpacing.toFixed(2));
				localRoutes = [
					{
						id: 1,
						key: 'nadir',
						label: '俯拍',
						gimbalPitchDegrees: this.isSmartOblique.value ? -Number(globeConfig.smartObliqueSwingAngle) : -90,
						segments: plan.segments,
					},
				];
			}

			if (Number(globeConfig.heightType) !== 3) {
				const allSegments: LocalRouteSegment[] = [];
				for (let routeIndex = 0; routeIndex < localRoutes.length; routeIndex++) {
					for (let segmentIndex = 0; segmentIndex < localRoutes[routeIndex].segments.length; segmentIndex++) {
						allSegments.push(localRoutes[routeIndex].segments[segmentIndex]);
					}
					const firstLocalWaypoint = getFirstLocalRoutePoint(localRoutes[routeIndex].segments);
					if (takeoffPoint && firstLocalWaypoint) {
						allSegments.push({ type: 'transit', points: [takeoffPoint, firstLocalWaypoint] });
					}
				}
				const maximumRouteTerrainHeight = await sampleMaximumTerrainHeightAlongSegments(window.mainViewer, frame, allSegments);
				if (version !== this.routeCalculationVersion) {
					return;
				}
				if (!Number.isFinite(heightResult.absoluteFlightHeight) || heightResult.absoluteFlightHeight! <= maximumRouteTerrainHeight) {
					throw new Error('实际航迹下方地形过高，当前高度无法安全规划');
				}
			}

			const plannedRoutes: PlannedRouteData[] = [];
			for (let routeIndex = 0; routeIndex < localRoutes.length; routeIndex++) {
				const localRoute = localRoutes[routeIndex];
				const rawCartesianSegments = await createCartesianRouteSegments(window.mainViewer, frame, localRoute.segments, {
					heightType: Number(globeConfig.heightType),
					lineHeight: Number(globeConfig.lineHeight),
					absoluteFlightHeight: heightResult.absoluteFlightHeight,
				});
				if (version !== this.routeCalculationVersion) {
					return;
				}
				const previewLocalSegments = roundPlanarRouteSegments(localRoute.segments);
				const roundedCartesianSegments = await createCartesianRouteSegments(window.mainViewer, frame, previewLocalSegments, {
					heightType: Number(globeConfig.heightType),
					lineHeight: Number(globeConfig.lineHeight),
					absoluteFlightHeight: heightResult.absoluteFlightHeight,
				});
				if (version !== this.routeCalculationVersion) {
					return;
				}
				if (Number(globeConfig.heightType) === 3 && takeoffPoint) {
					const firstLocalWaypoint = getFirstLocalRoutePoint(localRoute.segments);
					const firstCartesianWaypoint = getFirstCartesianRoutePoint(rawCartesianSegments);
					if (firstLocalWaypoint && firstCartesianWaypoint) {
						const maximumEntryTerrainHeight = await sampleMaximumTerrainHeightAlongSegments(window.mainViewer, frame, [
							{ type: 'transit', points: [takeoffPoint, firstLocalWaypoint] },
						]);
						if (version !== this.routeCalculationVersion) {
							return;
						}
						const firstWaypointCartographic = Cesium.Cartographic.fromCartesian(firstCartesianWaypoint);
						if (!firstWaypointCartographic || firstWaypointCartographic.height <= maximumEntryTerrainHeight) {
							throw new Error('起飞点到首航点之间地形过高，无法等高飞行');
						}
					}
				}
				// 圆角仅用于地图预览；导出使用原始折线航点，由司空 coordinateTurn 在转弯处平滑过点。
				const exportConnection = connectTakeoffToFirstWaypoint(rawCartesianSegments);
				const previewConnection = connectTakeoffToFirstWaypoint(roundedCartesianSegments);
				const missionLength = calculateCartesianRouteLength(rawCartesianSegments);
				const approachLength = Math.max(0, calculateCartesianRouteLength(exportConnection.segments) - missionLength);
				plannedRoutes.push({
					id: localRoute.id,
					key: localRoute.key,
					label: localRoute.label,
					headingDegrees: localRoute.headingDegrees,
					gimbalPitchDegrees: localRoute.gimbalPitchDegrees,
					segments: previewConnection.segments,
					exportSegments: rawCartesianSegments,
					coordinates: flattenRouteCoordinates(previewConnection.segments),
					totalLength: missionLength,
					climbLength: approachLength,
					photoCount: calculateRoutePhotoCount(rawCartesianSegments, photoDistance, true),
				});
			}
			if (plannedRoutes.length === 0) {
				throw new Error('当前测区未生成有效航线');
			}

			this.applyPlannedRoutes(plannedRoutes, photoDistance);
			await this.routeRenderer.waitForRoutePreviewReady(version);
			if (version !== this.routeCalculationVersion) {
				return;
			}
		} catch (error) {
			if (version !== this.routeCalculationVersion) {
				return;
			}
			globeConfig.lineLength = 0;
			globeConfig.takeoffClimbLength = 0;
			globeConfig.photoCount = 0;
			globeConfig.linesArrs = [];
			globeConfig.routeLinesArrs = [];
			this.plannedRoutes = [];
			this.photoDistance = 0;
			this.routeSummaries.value = [];
			this.hasRoute.value = false;
			const message = error instanceof Error ? error.message : '航线规划失败';
			ElMessage.error(message);
		} finally {
			if (version === this.routeCalculationVersion) {
				this.isCalculating.value = false;
			}
		}
	}

	/**
	 * 同步规划航线、统计数据和当前地图预览。
	 */
	private applyPlannedRoutes(plannedRoutes: PlannedRouteData[], photoDistance: number): void {
		if (plannedRoutes.length === 0) {
			throw new Error('当前测区未生成有效航线');
		}
		this.plannedRoutes = plannedRoutes;
		this.photoDistance = photoDistance;
		this.routeSummaries.value = [];
		for (let routeIndex = 0; routeIndex < plannedRoutes.length; routeIndex++) {
			const route = plannedRoutes[routeIndex];
			this.routeSummaries.value.push({
				id: route.id,
				key: route.key,
				label: route.label,
				totalLength: route.totalLength,
				climbLength: route.climbLength,
				photoCount: route.photoCount,
			});
		}
		if (this.activeRouteIndex.value >= plannedRoutes.length) {
			this.activeRouteIndex.value = 0;
		}

		let totalLength = 0;
		let totalClimbLength = 0;
		let totalPhotoCount = 0;
		const routeCoordinates: number[][] = [];
		for (let routeIndex = 0; routeIndex < plannedRoutes.length; routeIndex++) {
			totalLength += plannedRoutes[routeIndex].totalLength;
			totalClimbLength += plannedRoutes[routeIndex].climbLength;
			totalPhotoCount += plannedRoutes[routeIndex].photoCount;
			routeCoordinates.push([...plannedRoutes[routeIndex].coordinates]);
		}
		const activeRoute = plannedRoutes[this.activeRouteIndex.value];
		globeConfig.lineLength = Math.floor(totalLength * 10 + 1e-6) / 10;
		globeConfig.takeoffClimbLength = totalClimbLength;
		globeConfig.photoCount = totalPhotoCount;
		globeConfig.routeLinesArrs = routeCoordinates;
		globeConfig.linesArrs = [...activeRoute.coordinates];
		this.routeRenderer.drawFlightPath(activeRoute.segments);
	}

	/**
	 * 更新测区面积和共享测区坐标。
	 */
	private updatePolygonArea(): void {
		if (!this.entityObjPolygonObj) {
			return;
		}
		const positions = this.entityObjPolygonObj.polygonPositions;
		globeConfig.polygonPositions = positions;
		globeConfig.area = Number(calculateArea(positions).toFixed(2));
	}

	/**
	 * 将 Cesium 画布坐标换算为删除按钮相对定位容器（.wayMap）本地坐标后显示。
	 */
	private showDeleteButtonAtCanvasPosition(canvasPosition: { x: number; y: number }): void {
		const btn = this.delBtnRef.value;
		const viewer = window.mainViewer;
		if (!btn || !viewer) {
			return;
		}
		const canvas = viewer.canvas;
		const canvasRect = canvas.getBoundingClientRect();
		const host = btn.offsetParent instanceof HTMLElement ? btn.offsetParent : btn.parentElement;
		if (!host) {
			btn.style.left = `${canvasPosition.x}px`;
			btn.style.top = `${canvasPosition.y}px`;
			btn.style.display = 'block';
			return;
		}
		const hostRect = host.getBoundingClientRect();
		const canvasScaleX = canvas.clientWidth > 0 ? canvasRect.width / canvas.clientWidth : 1;
		const canvasScaleY = canvas.clientHeight > 0 ? canvasRect.height / canvas.clientHeight : 1;
		const visualX = canvasRect.left + canvasPosition.x * canvasScaleX;
		const visualY = canvasRect.top + canvasPosition.y * canvasScaleY;
		const hostScaleX = hostRect.width > 0 ? host.clientWidth / hostRect.width : 1;
		const hostScaleY = hostRect.height > 0 ? host.clientHeight / hostRect.height : 1;
		btn.style.left = `${(visualX - hostRect.left) * hostScaleX}px`;
		btn.style.top = `${(visualY - hostRect.top) * hostScaleY}px`;
		btn.style.display = 'block';
	}

	/**
	 * 隐藏测区删除浮层。
	 */
	private hideDeleteButton(): void {
		if (this.delBtnRef.value) {
			this.delBtnRef.value.style.display = 'none';
		}
	}

	//#endregion 业务逻辑 - 面状航线 END
}
