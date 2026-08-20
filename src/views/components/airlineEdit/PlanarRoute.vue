<!--
功能名称：面状航线
日    期：2025/06/23 14:57:55
-->
<template>
	<div class="planarRoutePage">
		<!-- 头部 -->
		<div class="wayline-edit-header">
			<div class="wayline-edit-header-left">
				<el-icon style="cursor: pointer" @click="handleBack"><ArrowLeftBold /></el-icon>
				<div class="divider"></div>
				<el-button type="primary" style="margin-left: 15px" :disabled="isCalculating || isImporting || !hasRoute" @click="handleSave">
					<template #icon>
						<el-icon style="cursor: pointer"><Files /></el-icon>
					</template>
					<template #default> 保存航线 </template>
				</el-button>
				<el-upload class="wayline-import-upload" :auto-upload="false" :show-file-list="false" accept=".kmz" :on-change="handlePlanarKmzSelect">
					<el-button type="primary" :loading="isImporting" :disabled="isCalculating">
						<template #icon>
							<el-icon><Upload /></el-icon>
						</template>
						<template #default> 导入航线 </template>
					</el-button>
				</el-upload>
			</div>
		</div>

		<div class="planar-content">
	<PlanarRouteConfigPanel
			:fly-point-status="flyPointStatus"
			:is-oblique-mode="isObliqueMode"
			:photo-trigger-options="photoTriggerOptions"
			:has-polygon="hasPolygon"
			:is-drawing-hole="isDrawingHole"
			:is-polygon-dirty="isPolygonDirty"
			:is-calculating="isCalculating"
			:hole-count="holeCount"
			@change="recalculateRoute"
			@update-fly-point="updateFlyPoint"
			@update-climb-type="updateClimbType"
			@change-line-angle="changeLineAngle"
			@line-angle-slider-start="beginLineAngleSliderInteraction"
			@line-angle-slider-input="handleLineAngleSliderInput"
			@line-angle-slider-change="handleLineAngleSliderChange"
			@start-hole-drawing="startHoleDrawing"
			@generate-route="generateRoute"
		/>
			<div class="wayMap planar-map" v-loading="isCalculating || isImporting" :element-loading-text="mapLoadingText">
				<CesiumMap @loadMap="loadMainMap"></CesiumMap>
				<div v-if="isObliqueMode && activeRouteSummary" class="route-switcher">
					<div class="route-switcher__tabs" role="tablist" aria-label="五向倾斜摄影航线">
						<button
							v-for="(route, index) in routeSummaries"
							:key="route.id"
							type="button"
							class="route-switcher__tab"
							:class="{ 'route-switcher__tab--active': activeRouteIndex === index }"
							:aria-selected="activeRouteIndex === index"
							@click="selectObliqueRoute(index)"
						>
							{{ route.id }}
						</button>
					</div>
					<div class="route-switcher__stats">
						<div class="route-switcher__stat">
							<div class="route-switcher__label">航线长度</div>
							<div class="route-switcher__value">{{ activeRouteSummary.lengthText }} m</div>
						</div>
						<div class="route-switcher__stat">
							<div class="route-switcher__label">预计时间</div>
							<div class="route-switcher__value">{{ activeRouteSummary.timeText }}</div>
						</div>
						<div class="route-switcher__stat">
							<div class="route-switcher__label">照片数</div>
							<div class="route-switcher__value">{{ activeRouteSummary.photoCount }}</div>
						</div>
					</div>
				</div>
				<div class="delBtn" ref="delBtnRef" @click="delPoy">删除测区</div>
				<div class="delBtn" ref="delHoleBtnRef" @click="deleteHole">删除挖孔</div>
				<div id="map-error-tip">
					<el-icon style="transform: translateY(3px)"><InfoFilled /></el-icon>
					测区不支持交叉面，无法生成航线
				</div>
			</div>
		</div>
	</div>
	<AircraftSelect v-if="isAircraftSelectShow" v-model="isAircraftSelectShow"></AircraftSelect>
	<SaveAirlineDialog
		v-model="showSaveDialog"
		:default-name="saveDialogDefaultName"
		:export-download="exportDownloadKmz"
	/>
</template>

<script lang="ts" src="./PlanarRoute.ts"></script>

<style scoped lang="scss">
.delBtn {
	display: none;
	position: absolute;
	z-index: 9999;
	z-index: 9999;
	color: #fff;
	cursor: pointer;
	padding: 8px 12px;
	color: #fff;
	background: #1f1f1f;
	border-radius: 4px;
	min-width: 196px;
	font-size: 14px;
	line-height: 22px;
	overflow: hidden;
	box-shadow: 0 0 8px rgba(0, 0, 0, 0.15);
}
.delBtn:hover {
	background: #0075ff;
}
.route-legend {
	position: absolute;
	right: 16px;
	bottom: 16px;
	z-index: 2;
	display: flex;
	gap: 16px;
	color: var(--el-text-color-primary);
	font-size: 13px;
}
.route-legend__item {
	display: flex;
	align-items: center;
	gap: 6px;
}
.route-legend__swatch {
	width: 18px;
	height: 3px;
}
.route-legend__swatch--scan {
	background: var(--el-color-success);
}
.route-legend__swatch--transit {
	background: var(--el-color-warning);
}
.route-switcher {
	position: absolute;
	left: 24px;
	top: 50%;
	z-index: 2;
	display: flex;
	align-items: center;
	transform: translateY(-50%);
}
.route-switcher__tabs {
	display: flex;
	flex-direction: column;
	width: 32px;
	background: var(--el-fill-color-darker);
	box-shadow: var(--el-box-shadow-light);
}
.route-switcher__tab {
	width: 32px;
	height: 32px;
	padding: 0;
	border: 0;
	border-radius: 0;
	background: #5d5f61;
	color: var(--el-color-white);
	font-size: 14px;
	cursor: pointer;
}
.route-switcher__tab--active,
.route-switcher__tab--active:hover {
	background: var(--el-color-primary);
}
.route-switcher__stats {
	display: flex;
	flex-direction: column;
	gap: 14px;
	min-width: 132px;
	margin-left: 22px;
	color: var(--el-color-white);
	text-shadow: var(--el-text-color-primary) 0 1px 3px;
}
.route-switcher__stat {
	display: flex;
	flex-direction: column;
}
.route-switcher__label {
	font-size: 14px;
	line-height: 20px;
}
.route-switcher__value {
	font-size: 20px;
	line-height: 26px;
}
#map-error-tip {
	position: absolute;
	top: 10px;
	left: 50%;
	transform: translateX(-50%);
	background: rgba($color: #f00, $alpha: 0.5);
	color: #fff;
	padding: 5px;
	border-radius: 6px;
	transition: all 0.5s ease-in-out;
	display: none;
}
.planarRoutePage {
	height: 100%;
	width: 100%;
	pointer-events: auto;
	display: flex;
	flex-direction: column;
	background: #232323;
	position: relative;
	user-select: none;
	overflow-y: hidden;
}
.pointer {
	cursor: pointer;
}
.divider {
	background: #4f4f4f;
	width: 1px;
	height: 19px;
	margin: auto 16px;
}
.wayline-import-upload {
	margin-left: 12px;
}
.planar-content {
	flex: 1;
	min-height: 0;
	display: flex;
	background: #101010;
	.wayMap {
		flex: 1;
		position: relative;
	}
}

.wayline-edit-header {
	color: #fff;
	justify-content: space-between;
	align-items: center;
	width: 100%;
	height: 54px;
	padding: 0 20px;
	display: flex;
	border-bottom: 1px solid rgb(79, 79, 79);
	position: relative;
	background: #232323;
	flex-shrink: 0;
	&-left {
		display: flex;
		align-items: center;
	}
	&-btn {
		cursor: pointer;
		height: 32px;
		padding: 4px 8px;
		border-radius: 4px;
		background: #4f4f4f;
		font-size: 14px;
		display: flex;
		align-items: center;
		margin-left: 20px;
	}
	.active {
		background: #2d8cf0;
	}

	&-center {
		height: 38px;
		background: #3c3c3c;
		cursor: pointer;
		border-radius: 4px;
		padding: 8px 16px;
		display: flex;
		align-items: center;
		font-size: 14px;
		position: absolute;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		.curWaylineType {
			display: flex;
			opacity: 0.65;
			align-items: center;
			margin-left: 20px;
			img {
				width: 16px;
				height: 16px;
				margin: 0 5px;
			}
		}
	}
}

// 起飞点鼠标样式
.map-menu-panel {
	cursor:
		url('./img/start_point.svg') 32 32,
		auto;
}
</style>

<style lang="scss">
/* 动态挂到 .wayMap，不能用 scoped */
.wayMap .draw-center-tips {
	text-align: center;
	pointer-events: none;
	color: #fff;
	background-color: rgba(0, 0, 0, 0.5);
	width: 800px;
	height: 64px;
	font-size: 14px;
	line-height: 64px;
	position: absolute;
	top: 144px;
	left: 50%;
	transform: translate(-50%);
	z-index: 20;
}
</style>
