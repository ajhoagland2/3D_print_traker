# Product Requirements

## Product Vision

Manufacturing Estimator helps engineering firms, additive manufacturing businesses, fabrication shops, product designers, and manufacturers plan 3D print production from manufacturing metrics rather than stored design files.

The product must be built around a non-negotiable intellectual property protection requirement:

> Your geometry files stay with you. We only need the manufacturing metrics.

Customer manufacturing files often contain proprietary part geometry, production techniques, customer designs, and other protected intellectual property. The platform must therefore keep STL, 3MF, and G-code files under customer control whenever technically feasible.

The product should compete on protection of customer intellectual property, privacy-first engineering workflows, secure manufacturing planning, low-risk adoption for engineering organizations, and enterprise-ready architecture.

## Core Value Proposition

Manufacturing Estimator turns local manufacturing file analysis into usable planning data for estimating, scheduling, inventory, and production reporting.

The core promise is:

> Your files stay with you. Your data is not for sale. Your subscription funds the software.

The application should consistently communicate that it stores manufacturing metrics, not proprietary geometry. Acceptable stored metrics include print time, filament consumption, material type, material cost, project name, scheduling information, inventory information, and production statistics.

Data that should not be stored by default includes STL geometry, CAD models, mesh data, proprietary part geometry, customer design files, or raw uploaded manufacturing files.

## Privacy Requirements

Raw geometry files must not be permanently stored on company servers by default. Raw geometry files must not be used for machine learning training, sold, shared, licensed, or distributed. Raw geometry files must not be accessible to company employees except through explicit customer support workflows authorized by the customer.

STL, 3MF, and G-code processing should occur locally in the user's browser whenever technically feasible. The system should extract only the manufacturing metrics required to provide application functionality.

Privacy messaging should appear prominently across the landing page, pricing page, privacy policy, FAQ, and account onboarding flow. Required message themes include:

- Your manufacturing files are analyzed locally.
- Your geometry files remain under your control.
- We do not sell customer data.
- We do not use customer files for AI training.
- We store manufacturing metrics, not proprietary geometry.
- Your subscription pays for the software, not through monetization of your data.

## Subscription Tier Differentiation

### Starter Plan - $9/month

- Local G-code analysis.
- Basic inventory management.
- Basic scheduling.
- Customer file processing remains local.

### Professional Plan - $29/month

- Local STL, 3MF, and G-code analysis.
- Cloud synchronization of extracted metrics.
- Team collaboration.
- Advanced scheduling.
- Inventory forecasting.

### Business Plan - $99/month

- Shared company workspaces.
- Audit logging.
- Advanced reporting.
- Role-based permissions.
- Cloud synchronization of extracted metrics only.

### Enterprise Plan - Custom Pricing

- Self-hosted deployment.
- Customer-controlled infrastructure.
- On-premise processing.
- SSO integration.
- Customer-owned databases.
- Full data residency controls.

## Architecture Requirement

The frontend target is React + Vite with a client-side file analysis engine, local processing first, and Progressive Web App compatibility.

The backend may store user accounts, subscription status, inventory records, scheduling records, and extracted manufacturing metrics. The backend must not require storage of raw STL, 3MF, or G-code files to provide core functionality.

Future cloud processing features must be opt-in, clearly disclosed, and must tell customers exactly what files are transmitted and why.
