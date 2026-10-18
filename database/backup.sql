-- Respaldo completo de transfer_db (transfer-service): esquema + datos de ejemplo (database/seed.sql).
-- Generado con pg_dump --no-owner --no-privileges. Restaurar en una base vacía:
--   psql "$DATABASE_URL" -f database/backup.sql

--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15
-- Dumped by pg_dump version 16.15

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: uuid-ossp; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: transfer_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.transfer_requests (
    id uuid DEFAULT public.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    source_account_id uuid NOT NULL,
    destination_account_number character varying(11) NOT NULL,
    amount numeric(18,2) NOT NULL,
    description character varying(140) DEFAULT 'Transferencia'::character varying NOT NULL,
    idempotency_key uuid NOT NULL,
    status character varying DEFAULT 'pending'::character varying NOT NULL,
    ledger_transaction_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    destination_key character varying(120),
    recipient_name character varying(80),
    destination_bank character varying(40),
    destination_account_type character varying(10),
    external_account_number character varying(16)
);


--
-- Data for Name: transfer_requests; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.transfer_requests (id, user_id, source_account_id, destination_account_number, amount, description, idempotency_key, status, ledger_transaction_id, created_at, updated_at, destination_key, recipient_name, destination_bank, destination_account_type, external_account_number) FROM stdin;
3d000000-0000-4000-8000-000000000001	11111111-1111-4111-8111-111111111111	3a000000-0000-4000-8000-000000000001	10000000002	150000.00	Arriendo compartido	7c000000-0000-4000-8000-000000000002	completed	7b000000-0000-4000-8000-000000000002	2026-10-02 15:00:00+00	2026-10-02 15:00:00+00	\N	\N	\N	\N	\N
\.


--
-- Name: transfer_requests PK_f97530bf47e4af43166089627ba; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.transfer_requests
    ADD CONSTRAINT "PK_f97530bf47e4af43166089627ba" PRIMARY KEY (id);


--
-- Name: IDX_99a5f61b472b6e60d940e2a01d; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "IDX_99a5f61b472b6e60d940e2a01d" ON public.transfer_requests USING btree (idempotency_key);


--
-- Name: idx_transfer_requests_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_transfer_requests_user_created ON public.transfer_requests USING btree (user_id, created_at);


--
-- PostgreSQL database dump complete
--


