# Embed completion event

An inline application embed dispatches `joo-embed:submitted` from its
`<joo-embed>` element when a submit press reaches the completed application
ceremony. The event bubbles and crosses the element's shadow boundary, so a host
page can listen on the element or an ancestor:

```js
document.querySelector('joo-embed')?.addEventListener('joo-embed:submitted', () => {
  // Collapse the embed, show the host site's own acknowledgement, or record a conversion.
});
```

The event deliberately has no `detail`. Submission answers, identity, tokens,
and internal message envelopes never cross into the host page. A single embed
mount dispatches the event at most once.
