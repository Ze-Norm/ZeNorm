export type Fixture = {
  id: string;
  title: string;
  owner: string;
  status: "draft" | "review" | "approved";
};

/** Stand-in records. Replace with the shapes this demo is really about. */
export const fixtures: Fixture[] = [
  { id: "EX-04", title: "Route a held revision back to its author", owner: "Kim", status: "draft" },
  { id: "EX-05", title: "Collapse the two approval steps into one", owner: "Sam", status: "review" },
  { id: "EX-06", title: "Keep the decided revision after a reopen", owner: "Kim", status: "approved" },
  { id: "EX-07", title: "Show verified work apart from merged work", owner: "Jo", status: "review" },
];
