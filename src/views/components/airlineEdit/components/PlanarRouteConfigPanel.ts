/**
 * 功能名称：面状航线配置面板
 * 日    期：2026/07/29
 */
import { computed, defineComponent, ExtractPropTypes, nextTick, onMounted, onUnmounted, PropType, ref, SetupContext, watchEffect } from 'vue';
import globeConfig, { PLANAR_EDIT_DEFAULTS, PLANAR_SPEED_HARD_MAX } from '../config/planarConfig';
import BaseInstance from '@/utils/BaseInstance';

// 一、Emits 类型定义
type EmitsType = (
	| 'change'
	| 'updateFlyPoint'
	| 'updateClimbType'
	| 'changeLineAngle'
	| 'lineAngleSliderStart'
	| 'lineAngleSliderInput'
	| 'lineAngleSliderChange'
	| 'startHoleDrawing'
	| 'generateRoute'
)[];

// 二、Props 定义
const propDefine = {
	flyPointStatus: {
		type: Boolean,
		default: false,
	},
	isObliqueMode: {
		type: Boolean,
		default: false,
	},
	photoTriggerOptions: {
		type: Array as PropType<{ label: string; value: string }[]>,
		default: () => [],
	},
	hasPolygon: {
		type: Boolean,
		default: false,
	},
	isDrawingHole: {
		type: Boolean,
		default: false,
	},
	isPolygonDirty: {
		type: Boolean,
		default: false,
	},
	isCalculating: {
		type: Boolean,
		default: false,
	},
	holeCount: {
		type: Number,
		default: 0,
	},
};

// 三、组件信息定义
export default defineComponent({
	name: 'PlanarRouteConfigPanel',
	components: {},
	emits: [
		'change',
		'updateFlyPoint',
		'updateClimbType',
		'changeLineAngle',
		'lineAngleSliderStart',
		'lineAngleSliderInput',
		'lineAngleSliderChange',
		'startHoleDrawing',
		'generateRoute',
	],
	props: propDefine,
	setup(props, ctx) {
		return new Instance(props, ctx);
	},
});

// 四、组件实例，具体业务
export class Instance extends BaseInstance {
	private props: ExtractPropTypes<typeof propDefine>;
	private ctx: SetupContext<EmitsType>;

	// 响应属性
	inputRef = ref<{ focus: () => void } | null>(null);
	showHeightInput = ref(false);
	showSpeedInput = ref(false);
	showTakeOffSpeedInput = ref(false);
	scrollbarRef = ref<{ setScrollTop: (height: number) => void } | null>(null);

	/** 模块级响应式单例，直接挂为自有属性供模板访问 */
	globeConfig = globeConfig;

	/** 建议限速（重叠约束），仅作提示；手动可调至硬上限 15 */
	flightSpeedSuggested = computed(() => {
		const maxSpeed = Number(globeConfig.maxSpeed);
		return Number.isFinite(maxSpeed) && maxSpeed > 0 ? maxSpeed : PLANAR_SPEED_HARD_MAX;
	});

	/** 速度已达硬上限 15 时禁用 + */
	isFlightSpeedAtHardMax = computed(() => Number(globeConfig.speed) >= PLANAR_SPEED_HARD_MAX - 1e-6);

	// 私有属性
	private collapseScrollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(props: ExtractPropTypes<typeof propDefine>, ctx: SetupContext<EmitsType>) {
		super();
		this.props = props;
		this.ctx = ctx;
		this.init();
	}

	private init() {
		onMounted(() => {
			watchEffect(() => {
				if (this.showHeightInput.value || this.showSpeedInput.value || this.showTakeOffSpeedInput.value) {
					nextTick(() => {
						this.inputRef.value?.focus();
					});
				}
			});
		});

		onUnmounted(() => {
			if (this.collapseScrollTimer) {
				clearInterval(this.collapseScrollTimer);
				this.collapseScrollTimer = null;
			}
		});
	}

	//#region 业务逻辑 - props 透传

	get flyPointStatus() {
		return this.props.flyPointStatus;
	}

	get isObliqueMode() {
		return this.props.isObliqueMode;
	}

	get photoTriggerOptions() {
		return this.props.photoTriggerOptions as { label: string; value: string }[];
	}

	get hasPolygon() {
		return this.props.hasPolygon;
	}

	get isDrawingHole() {
		return this.props.isDrawingHole;
	}

	get isPolygonDirty() {
		return this.props.isPolygonDirty;
	}

	get isCalculating() {
		return this.props.isCalculating;
	}

	get holeCount() {
		return this.props.holeCount;
	}

	/** 通知父组件开始挖孔 */
	startHoleDrawing = () => {
		this.ctx.emit('startHoleDrawing');
	};

	/** 通知父组件根据当前测区重新生成航线 */
	generateRoute = () => {
		this.ctx.emit('generateRoute');
	};

	/** 通知父组件切换起飞点 */
	updateFlyPoint = () => {
		this.ctx.emit('updateFlyPoint');
	};

	/** 通知父组件切换采集方式 */
	updateClimbType = (value: number) => {
		this.ctx.emit('updateClimbType', value);
	};

	/** 通知父组件调整主航线角度 */
	changeLineAngle = (delta: number) => {
		this.ctx.emit('changeLineAngle', delta);
	};

	/** 通知父组件主航线角度滑块按下 */
	beginLineAngleSliderInteraction = (event: PointerEvent) => {
		this.ctx.emit('lineAngleSliderStart', event);
	};

	/** 通知父组件主航线角度滑块拖动 */
	handleLineAngleSliderInput = (value: number | number[]) => {
		this.ctx.emit('lineAngleSliderInput', value);
	};

	/** 通知父组件主航线角度滑块松开 */
	handleLineAngleSliderChange = (value: number | number[]) => {
		this.ctx.emit('lineAngleSliderChange', value);
	};

	//#endregion 业务逻辑 - props 透传 END

	//#region 业务逻辑 - 配置更新

	/** 修改航线高度并通知父组件重新规划 */
	calclineHeight = (value: number) => {
		this.showHeightInput.value = false;
		globeConfig.lineHeight = Number(globeConfig.lineHeight);
		globeConfig.lineHeight += value;
		globeConfig.lineHeight = Math.min(1500, Math.max(2, globeConfig.lineHeight));
		this.ctx.emit('change');
	};

	/** 修改高度模式并通知父组件重新规划 */
	updateHeightType = (value: number) => {
		globeConfig.heightType = value;
		this.ctx.emit('change');
	};

	/** 调整航线速度并通知父组件重新规划（硬上限 15，可超过建议限速） */
	changeFlightSpeed = (delta: number) => {
		const speed = Number(globeConfig.speed);
		const current = Number.isFinite(speed) ? speed : PLANAR_EDIT_DEFAULTS.speed;
		globeConfig.speed = Math.min(PLANAR_SPEED_HARD_MAX, Math.max(1, current + delta));
		this.ctx.emit('change');
	};

	/** 提交输入框中的航线速度并通知父组件重新规划 */
	handleFlightSpeedBlur = () => {
		this.showSpeedInput.value = false;
		const speed = Number(globeConfig.speed);
		globeConfig.speed = Number.isFinite(speed) ? Math.min(PLANAR_SPEED_HARD_MAX, Math.max(1, speed)) : PLANAR_EDIT_DEFAULTS.speed;
		this.ctx.emit('change');
	};

	/** 修改云台俯仰角并通知父组件重新规划 */
	changeGimbalPitch = (delta: number) => {
		const next = Number(globeConfig.smartObliqueGimbalPitch) + delta;
		globeConfig.smartObliqueGimbalPitch = Math.min(-40, Math.max(-85, next));
		this.ctx.emit('change');
	};

	/** 云台俯仰角滑块松开后通知父组件重新规划 */
	handleGimbalPitchSliderChange = (value: number | number[]) => {
		if (Array.isArray(value)) {
			return;
		}
		globeConfig.smartObliqueGimbalPitch = Math.min(-40, Math.max(-85, Number(value)));
		this.ctx.emit('change');
	};

	/** 调整起飞速度并通知父组件重新规划 */
	changeTakeoffSpeed = (delta: number) => {
		const speed = Number(globeConfig.takeoffSpeed);
		const current = Number.isFinite(speed) ? speed : PLANAR_EDIT_DEFAULTS.takeoffSpeed;
		globeConfig.takeoffSpeed = Math.min(15, Math.max(1, current + delta));
		this.ctx.emit('change');
	};

	/** 提交输入框中的起飞速度并通知父组件重新规划 */
	handleTakeoffSpeedBlur = () => {
		this.showTakeOffSpeedInput.value = false;
		const speed = Number(globeConfig.takeoffSpeed);
		globeConfig.takeoffSpeed = Number.isFinite(speed) ? Math.min(15, Math.max(1, speed)) : PLANAR_EDIT_DEFAULTS.takeoffSpeed;
		this.ctx.emit('change');
	};

	/** 拍照触发模式变化后通知父组件重新规划 */
	handlePhotoTriggerChange = () => {
		this.ctx.emit('change');
	};

	/** 调整重叠率并通知父组件重新规划 */
	changeOverlap = (field: 'overlapW' | 'overlapH', delta: number) => {
		globeConfig[field] = Math.min(90, Math.max(10, Number(globeConfig[field]) + delta));
		this.ctx.emit('change');
	};

	//#endregion 业务逻辑 - 配置更新 END

	//#region 业务逻辑 - 高级设置折叠滚动

	/** 高级设置折叠展开时自动滚动到底部 */
	collapseChange = (names: string | number | Array<string | number>) => {
		const opened = Array.isArray(names) ? names.length > 0 : names === '1' || names === 1;
		if (!opened || !this.scrollbarRef.value) {
			return;
		}
		if (this.collapseScrollTimer) {
			clearInterval(this.collapseScrollTimer);
		}
		let height = 0;
		this.collapseScrollTimer = setInterval(() => {
			height += 20;
			this.scrollbarRef.value?.setScrollTop(height);
			if (height >= 600 && this.collapseScrollTimer) {
				clearInterval(this.collapseScrollTimer);
				this.collapseScrollTimer = null;
			}
		}, 16);
	};

	//#endregion 业务逻辑 - 高级设置折叠滚动 END
}
