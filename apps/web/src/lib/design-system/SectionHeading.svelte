<script lang="ts">
  interface Props {
    index: string;
    title: string;
    description: string;
  }

  let { index, title, description }: Props = $props();
</script>

<header class="ds-section-heading">
  <span>{index}</span>
  <div>
    <h2>{title}</h2>
    <p>{description}</p>
  </div>
</header>
