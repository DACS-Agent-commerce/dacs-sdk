# `create-dacs-agent`

Project generator for the DACS one-click quickstart.

The first stacked work package supports only the deterministic offline profile:

```bash
npm create dacs-agent@latest my-agent -- --yes --run
```

It generates a small application that calls the reviewed
`@kynesyslabs/dacs-node` lifecycle. The mocked AP2 payment is visibly offline;
the project does not claim x402, Demos settlement, live readiness or real funds.

Live generation fails closed until the durable host, doctor and guarded command
work packages have landed and passed their acceptance tests.
