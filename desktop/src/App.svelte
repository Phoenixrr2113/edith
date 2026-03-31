<script lang="ts">
	let greeting = "Edith is running.";
</script>

<main>
	<h1>{greeting}</h1>
	<p>Desktop companion — Tauri v2 + Svelte 5</p>
</main>

<style>
	:global(body) {
		margin: 0;
		padding: 0;
		font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		background: transparent;
		color: #e0e0e0;
	}

	main {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100vh;
		text-align: center;
	}

	h1 {
		font-size: 1.5rem;
		font-weight: 600;
		margin-bottom: 0.5rem;
	}

	p {
		font-size: 0.875rem;
		opacity: 0.6;
	}
</style>
