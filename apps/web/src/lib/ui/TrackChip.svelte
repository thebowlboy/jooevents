<script lang="ts">
  import { trackAccent, hasTrack, type TrackAccent } from './track-accents';

  interface Props {
    /**
     * The track's name. Blank renders **nothing** — a submission with no track
     * has no category, and an empty capsule is the defect this primitive
     * exists to make unrepresentable.
     */
    name?: string | null;
    /** The track's id; decides the accent. Falls back to the name. */
    id?: string;
    /**
     * The event's own track order. Position in it walks the palette from the
     * top, so a programme of eight or fewer tracks gets eight distinct
     * accents and the same track wears one colour on every surface. Without
     * it the accent is hashed from the id: stable, but two tracks can collide.
     */
    order?: readonly string[];
    /** Pin an accent explicitly, for a workbench specimen or a fixed legend. */
    accent?: TrackAccent;
  }

  let { name, id, order, accent }: Props = $props();

  const resolved = $derived(accent ?? trackAccent(id ?? name ?? '', order));
</script>

{#if hasTrack(name)}
  <span class="ui-track ui-track--{resolved}" title={name}>
    <span class="ui-track__label">{name}</span>
  </span>
{/if}
