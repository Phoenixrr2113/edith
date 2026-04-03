<script lang="ts">
	/**
	 * Animated Rive character — Edith's desktop pet.
	 *
	 * Uses "robot-expressions" asset with 5 expression states + cursor tracking.
	 *
	 * State Machine: "State Machine 1"
	 * Triggers: "Happy button", "Sad button", "Scared button",
	 *           "Surprised button", "Smiling button"
	 * Boolean: "IsTracking" (cursor follow)
	 * Seasonal: "Christmas button", "Halloween button", "Easter button"
	 */

	import { onMount, onDestroy } from 'svelte';

	// ── Types ──────────────────────────────────────────────────────────────────

	export type AgentState = 'idle' | 'thinking' | 'talking' | 'error' | 'offline' | 'alert';

	interface Props {
		agentState?: AgentState;
		size?: number;
	}

	let { agentState = 'idle', size = 200 }: Props = $props();

	// ── Internal state ────────────────────────────────────────────────────────

	let canvas: HTMLCanvasElement;
	let riveInstance: any = null;
	let stateMachineInputs: any[] = [];
	let lastTriggeredState: AgentState | null = null;
	let appWindow: any = null;

	// ── Rive helpers ──────────────────────────────────────────────────────────

	function fireTrigger(name: string): void {
		const input = stateMachineInputs.find(
			(i: any) => i.name === name && typeof i.fire === 'function'
		);
		if (input) input.fire();
	}

	function setBoolInput(name: string, value: boolean): void {
		const input = stateMachineInputs.find(
			(i: any) => i.name === name && typeof i.value === 'boolean'
		);
		if (input) input.value = value;
	}

	// ── State → expression mapping ────────────────────────────────────────────

	const STATE_TO_TRIGGER: Record<AgentState, string> = {
		idle: '',                     // Natural idle — no trigger needed
		thinking: 'Smiling button',   // Smiling while working
		talking: 'Happy button',      // Happy when speaking to user
		error: 'Sad button',          // Sad when something broke
		offline: 'Scared button',     // Scared when disconnected
		alert: 'Surprised button',    // Surprised for urgent notifications
	};

	function applyState(state: AgentState): void {
		if (state === lastTriggeredState) return;
		lastTriggeredState = state;

		const trigger = STATE_TO_TRIGGER[state];
		if (trigger) {
			fireTrigger(trigger);
		}
		// 'idle' has no trigger — robot returns to idle naturally after expressions
	}

	// ── Drag ──────────────────────────────────────────────────────────────────

	async function onMouseDown(e: MouseEvent): Promise<void> {
		if (e.button === 0 && appWindow) {
			await appWindow.startDragging();
		}
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	onMount(async () => {
		// Tauri window (for drag)
		try {
			const { getCurrentWindow } = await import('@tauri-apps/api/window');
			appWindow = getCurrentWindow();
		} catch {
			// Not in Tauri
		}

		// Load Rive
		const { Rive: RiveCanvas } = await import('@rive-app/canvas-lite');

		try {
			riveInstance = new RiveCanvas({
				src: '/cute-robot.riv',
				canvas,
				autoplay: true,
				artboard: 'Main',
				stateMachines: 'State Machine 1',
				onLoad: () => {
					console.log('[Rive] Robot-expressions loaded');
					stateMachineInputs = riveInstance.stateMachineInputs('State Machine 1') ?? [];
					console.log('[Rive] Inputs:', stateMachineInputs.map((i: any) =>
						`${i.name} (${typeof i.fire === 'function' ? 'trigger' : typeof i.value})`
					));
					// Enable cursor tracking
					setBoolInput('IsTracking', true);
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

	// ── Reactivity ────────────────────────────────────────────────────────────

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
