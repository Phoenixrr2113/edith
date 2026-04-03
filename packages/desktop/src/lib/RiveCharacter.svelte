<script lang="ts">
	/**
	 * Animated Rive character — Edith's desktop pet.
	 *
	 * Small transparent window. Click+drag moves the entire window
	 * via Tauri's startDragging(). Right-click toggles controls.
	 * Rive handles cursor tracking automatically via its state machine.
	 */

	import { onMount, onDestroy } from 'svelte';

	export type AgentState = 'idle' | 'thinking' | 'talking' | 'error' | 'offline';

	interface Props {
		agentState?: AgentState;
		size?: number;
	}

	let { agentState = 'idle', size = 200 }: Props = $props();

	let canvas: HTMLCanvasElement;
	let riveInstance: any = null;
	let stateMachineInputs: any[] = [];
	let lastTriggeredState: AgentState | null = null;

	let appWindow: any = null;

	function applyState(state: AgentState): void {
		if (state === lastTriggeredState) return;
		lastTriggeredState = state;
	}

	async function onMouseDown(e: MouseEvent): Promise<void> {
		if (e.button === 0 && appWindow) {
			// Left click — start dragging the window
			await appWindow.startDragging();
		}
	}

	onMount(async () => {
		const { getCurrentWindow } = await import('@tauri-apps/api/window');
		try {
			appWindow = getCurrentWindow();
		} catch {
			// Not in Tauri — running in browser, skip drag
		}
		const { Rive: RiveCanvas } = await import('@rive-app/canvas-lite');

		try {
			riveInstance = new RiveCanvas({
				src: '/cute-robot.riv',
				canvas,
				autoplay: true,
				artboard: 'Main',
				stateMachines: 'State Machine 1',
				onLoad: () => {
					console.log('[Rive] Cute robot loaded');
					stateMachineInputs = riveInstance.stateMachineInputs('State Machine 1') ?? [];
					console.log('[Rive] Inputs:', stateMachineInputs.map((i: any) => `${i.name} (${typeof i.value})`));
					applyState(agentState);
				},
				onLoadError: (err: any) => {
					console.error('[Rive] Load error:', err);
				},
			});
		} catch (err) {
			console.error('[Rive] Init error:', err);
		}
	});

	onDestroy(() => {
		riveInstance?.cleanup();
		riveInstance = null;
	});

	$effect(() => {
		if (riveInstance && stateMachineInputs.length > 0) {
			applyState(agentState);
		}
	});
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="character-container"
	style:width="{size}px"
	style:height="{size}px"
	onmousedown={onMouseDown}
>
	<canvas
		bind:this={canvas}
		width={size * 2}
		height={size * 2}
	></canvas>
</div>

<style>
	.character-container {
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: grab;
	}

	.character-container:active {
		cursor: grabbing;
	}

	canvas {
		width: 100%;
		height: 100%;
		background: transparent !important;
	}
</style>
