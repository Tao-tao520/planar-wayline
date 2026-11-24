/**
 * 功能名称：飞行器选择
 * 日    期：2025/05/30 15:41:25
 */
import { defineComponent, ref, computed, onMounted, onUnmounted, ExtractPropTypes, SetupContext } from 'vue';
import { ElMessage } from 'element-plus';
import BaseInstance from '@/utils/BaseInstance';
import gsap from 'gsap';
import { keyBindingSwitch } from '../utils/keyBinding';
import { AIRCRAFT_SERIES, WAYLINE_KINDS, WaylineKindId, findSeries } from '../config/devices';
import { getSelectedAircraft, selectAircraft } from '../config/selectedAircraft';
// 一、Emits 类型定义
type EmitsType = ('update:modelValue' | 'saved')[];

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
	components: {},
	emits: ['update:modelValue', 'saved'],
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
	keyBindingSwitch = keyBindingSwitch
	constructor(props: ExtractPropTypes<typeof propDefine>, ctx: SetupContext<EmitsType>) {
		super();
		this.props = props;
		this.ctx = ctx;
		this.init();
	}
	private init() {
		const name = sessionStorage.getItem('aircraftName');
		if (name) {
			this.aircraftName.value = name;
		}
		const current = getSelectedAircraft();
		this.activeSeriesId.value = current.seriesId;
		this.activeModelId.value = current.id;
		onMounted(() => {
			this.show();
		});
		onUnmounted(() => {});
	}

	//#region 业务逻辑 - xxx

	// 私有属性 | private

	// 响应属性 | ref、reactive、computed

	waylineKinds = WAYLINE_KINDS;
	aircraftList = AIRCRAFT_SERIES;
	activeWaylineKind = ref<WaylineKindId>('planar');
	activeSeriesId = ref(100);
	activeModelId = ref('m4td');
	modelList = computed(() => findSeries(this.activeSeriesId.value)?.models ?? []);
	aircraftName = ref('新建航线');

	// 私有方法 | private 方法名() {}

	// 响应式方法 | xxx = () => {}

	changeWaylineKind = (kindId: WaylineKindId) => {
		this.activeWaylineKind.value = kindId;
	};

	/** 选择飞行器系列，型号切到该系列第一项 */
	changeAircraft = (seriesId: number) => {
		this.activeSeriesId.value = seriesId;
		const models = findSeries(seriesId)?.models ?? [];
		if (!models.some((item) => item.id === this.activeModelId.value) && models[0]) {
			this.activeModelId.value = models[0].id;
		}
	};

	/** 选择型号 */
	changeModel = (modelId: string) => {
		this.activeModelId.value = modelId;
	};

	show = () => {
		gsap.fromTo('.box', { scale: 0, top: 50, duration: 0 }, { scale: 1, top: '50%', duration: 0.3 });
	};

	doClose = () => {
		gsap.to('.box', {
			scale: 0,
			opacity: 0,
			top: 50,
			duration: 0.3,
			onComplete: () => {
				this.ctx.emit('update:modelValue', false);
			},
		});
	};

	handleSave = () => {
		const kind = WAYLINE_KINDS.find((item) => item.id === this.activeWaylineKind.value);
		if (!kind?.editable) {
			ElMessage.warning('该航线绘制尚未接入，请先选择面状航线');
			return;
		}
		selectAircraft(this.activeModelId.value);
		sessionStorage.setItem('aircraftName', this.aircraftName.value);
		this.ctx.emit('saved');
		this.doClose();
	};

	//#endregion 业务逻辑 - xxx END
}
